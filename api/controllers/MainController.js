/**
 * MainController
 *
 * @description :: Server-side logic for managing mains
 * @help        :: See http://sailsjs.org/#!/documentation/concepts/Controllers
 */
const fs = require('fs');
const async = require('async');
const fx = require('money');
const AWS = require('aws-sdk');
const moment = require('moment-timezone');
const s3Zip = require('s3-zip');

fx.base='INR';
fx.rates=sails.config.fx_rates;

var temp_count = 10;

var request = require("request");
var jwt = require("jsonwebtoken");
module.exports = {
	landingPage:function(req,res){
		if(req.user){
			Member.find({ user:req.user.id }).populate('org').sort('id ASC').exec(function(err,memberships){
				if (req.user.details && req.user.details.settings && req.user.details.settings.default_org){
					res.redirect('/org/' + req.user.details.settings.default_org + '/dashboard');
				} else{
					res.redirect('/org/'+memberships[0].org.id+'/dashboard');
				}
			});
			// res.view('landing_page');
		} else 
			res.redirect('/login')
	},
	listCategories:function(req,res){
		Category.find({org:req.org.id}).sort('name ASC').exec(function(err,categories){
			var locals={
				categories:categories
			}
			locals.parents=GeneralService.orderCategories(categories);
			res.view('list_categories',locals);
		});
	},
	createCategory:function(req,res){
		if(_.isArray(req.body)){
			_.forEach(req.body, function(c){
				c.org = req.org.id
			});

			Category.create(req.body).exec(function(err, cats){
				if(err)
					return res.status(500).json({error: err.message})
				return res.json(cats);
			});
		}
		else{

			Category.find({ org: req.org.id }).sort('name ASC').exec(function(err,categories){
			if(req.body){ // post request
				if(!req.body.budget)
					req.body.budget='10000';
				var c={
					name:req.body.name,
					description:req.body.description,
					budget:parseInt(req.body.budget),
					org:req.org.id,
					type:req.body.type,
				}
				if(req.body.parent_id)
					c.parent=req.body.parent_id;
				// console.log('before transaction find or create');
				console.log(c);
				Category.create(c).exec(function(err,transaction){
					if(err){
						console.log(err);
						throw err;
					}
					else
						res.redirect('/org/' + req.org.id +'/categories');
				});
			}else{ // view the form
				var locals={
					status:'',
					message:'',
					name:'',
					description:'',
					budget:'10000',
					parent_id:'',
					type:'expense',
					categories:GeneralService.orderCategories(categories)
				}

				console.log(locals);
				res.view('create_category',locals);
			}
		})
		}
	},
	viewCategory:function(req,res){
		// get account of the user
		// find sub categories
		var locals = {};
		async.auto({
			getCategory:function(callback){
				Category.findOne({id:req.params.id}).populate('parent').exec(callback)
			},
			getChildrenCategories:function(callback){
				Category.find({parent:req.params.id}).exec(callback)
			},
			getAccounts:function(callback){
				Account.find({org:req.org.id}).exec(callback)
			}
		},function(err,results){

			var locals = {
				category:results.getCategory,
				children_categories:results.getChildrenCategories,
				// user_accounts:results.getAccounts,
				metabase:{}
			}
			var questions=[
				{
					url_name:'sub_categories_expense',
					question_id:26,
					params:{
						account_ids:_.map(results.getAccounts,'id').join(','),
						category_ids:_.map(results.getChildrenCategories,'id').join(','),
					}
				},
				{
					url_name:'sub_categories_income',
					question_id:27,
					params:{
						account_ids:_.map(results.getAccounts,'id').join(','),
						category_ids:_.map(results.getChildrenCategories,'id').join(','),
					}
				},
				{
					url_name:'income_expense',
					question_id:28,
					params:{
						category_ids:""+results.getCategory.id,
					}
				},
			]
			questions.forEach(function(q){
				var payload = {
					resource: { question: q.question_id },
					params:q.params,
				};
				var token = jwt.sign(payload, sails.config.metabase.secret_key);
				locals.metabase[q.url_name]=sails.config.metabase.site_url + "/embed/question/" + token + "#bordered=true&titled=false";
				console.log('\n\n\n---------');
				console.log(payload);
			});
			console.log('\n\n\n---------');
			console.log(locals);
			res.view('view_category',locals);

		});
	},
	editCategory:function(req,res){
		Category.find({ org: req.org.id }).sort('name ASC').exec(function(err,categories){
			if(!_.find(categories,{id:parseInt(req.params.id)}))
				return res.send('you dont have permission to modify this category');
			if(req.body){
				var c={
					name:req.body.name,
					description:req.body.description,
					budget:parseInt(req.body.budget),
					org:req.org.id,
					type:req.body.type,
					parent:null,
				}
				if(req.body.parent_id)
					c.parent=req.body.parent_id;
				// console.log('before transaction find or create');
				console.log(c);
				Category.update({id:req.params.id},c).exec(function(err,transaction){
					if(err){
						console.log(err);
						throw err;
					}
					else
						res.redirect('/org/' + req.org.id +'/categories');
				});

			}else{
				console.log(categories);
				console.log(req.params.id);
				var c = _.find(categories,{id:parseInt(req.params.id)});
				console.log(c);
				var locals={
					status:'',
					message:'',
					name:c.name,
					description:c.description,
					budget:c.budget,
					parent_id:c.parent,
					type:c.type,
					categories:GeneralService.orderCategories(categories)
				}
				res.view('create_category',locals);
			}
		});
	},
	deleteCategory:function(req,res){
		async.auto({
			getCategory:function(callback){
				Category.findOne({id:req.params.id,org:req.org.id}).populate('parent').exec(callback);
			},
			getTransactionCategoriesCount:function(callback){
				Transaction_category.count({category:req.params.id}).exec(callback);
			},
			getChildrenCategories:function(callback){
				Category.find({parent:req.params.id,org:req.org.id}).exec(callback);
			}
		},function(err,results){
			if(err)
				throw err;
			if(req.body && req.body.confirm){ // confirming delete
				if(results.getChildrenCategories.length>0)
					res.send('this category has sub-categories. Delete all the sub-categories first');
				async.auto({
					getTrasactionCategories:function(callback){
						Transaction_category.find({category:req.params.id}).exec(callback);
					},
					updateTransactionCategories:['getTrasactionCategories',function(results,callback){
						var t_ids=_.map(results.getTrasactionCategories,'id');
						Transaction_category.update({id:t_ids},{category:null}).exec(callback);
					}],
					deleteCategory:['updateTransactionCategories',function(results,callback){
						Category.destroy({id:req.params.id}).exec(callback);
					}]
				},function(err,results){
					if(err)
						throw(err);
					res.redirect('/org/' + req.org.id +'/categories');
				})
				
			}else{ // showing the warning page
				
				var locals={
					category:results.getCategory,
					transactions_count:results.getTransactionCategoriesCount,
					children:results.getChildrenCategories,
				};
				console.log(locals);
				res.view('delete_category',locals);
			}
		})
		
	},
	listEmails:function(req,res){
		Email.find({org:req.org.id}).exec(function(err,emails){
			var locals={
				emails:emails
			}
			res.view('list_emails',locals);
		});
	},
	viewEmail: function(req, res){
		async.auto({
			getEmail: function(cb){
				Email.findOne({id: req.params.id, org:req.org.id})
					.exec(function(err, e){
						if(err) return cb(err);
						if(!e) return cb(new Error('Invalid Email'));
						return cb(null, e);
					});
			},
			findParsedEmails: ['getEmail', function(results, cb){
				Parsed_email.find({email: results.getEmail.email, org:req.org.id}).sort('createdAt DESC').limit(100).exec(cb);
			}],
			findParseFailures:['getEmail', function(results, cb){
				Parse_failure.find({email: results.getEmail.email, org:req.org.id}).sort('createdAt DESC').limit(100).exec(cb);
			}] 
		}, function(err, results){
			var locals={
				error: err? err.message:'',
				email:results.getEmail,
				parsed_emails: results.findParsedEmails,
				parse_failures: results.findParseFailures,
				moment: require('moment-timezone')
			}
			res.view('view_email',locals);
		})
	},
	retryParseFailure: function(req, res){
		async.auto({
			getParseFailure: function(cb){
				Parse_failure.findOne({id: req.params.id, org:req.org.id}).exec(function(err, pf){
					if(err) return cb(err);
					if(!pf || !_.get(pf, 'details.inbound')) return cb(new Error("NOT_FOUND"));
					return cb(null, pf);
				});
			},
			retryParsing: ['getParseFailure', function(results, cb){
				MailgunService.parseInboundEmail(_.get(results, 'getParseFailure.details.inbound'), cb);
			}]
		}, function(err, results){
			if(err){
				switch (err.message) {
					case 'NOT_FOUND':
						return res.status(404).json({error: 'NOT_FOUND'})
						break;
				
					default:
						return res.status(500).json({error: err.message});
						break;
				}
			}
			return res.json({status: 'success'})
		});
	},
	listParseFailures:function(req,res){
		var limit = req.query.limit?parseInt(req.query.limit): 25;
		var page = req.query.page?parseInt(req.query.page):1;
		var skip = limit * (page-1);
		async.auto({
			getParseFailures:function(callback){
				Parse_failure.find({org:req.params.o_id,status:'FAILED'})
					.sort('createdAt DESC')
					.limit(limit)
					.skip(skip)
					.exec(callback);
			},
		},function(err,results){
			var locals={
				parse_failures:results.getParseFailures,
				page: page,
				limit:limit,
			}
			res.view('list_parse_failures',locals);
		})
	},
	viewParseFailure:function(req,res){
		Parse_failure.findOne({org:req.params.o_id,id:req.params.pf_id}).exec(function(err,pf){
			var locals={
				pf:pf
			}
			res.view('view_parse_failure',locals);
		})
	},
	listParsedEmails:function(req,res){
		var limit = req.query.limit?parseInt(req.query.limit): 25;
		var page = req.query.page?parseInt(req.query.page):1;
		var skip = limit * (page-1);
		var filter = {
			org: req.org.id,
		}
		// only allow white listed status
		if(req.query.status && _.includes(['PARSED', 'PARSE_FAILED', 'JUNK'], req.query.status))
			filter.status = req.query.status;

		async.auto({
			getParsedEmails:function(callback){
				Parsed_email.find(filter)
					.sort('createdAt DESC')
					.limit(limit)
					.skip(skip)
					.exec(callback);
			},
			getDTEs: ['getParsedEmails', function(results, cb){
				var pe_ids = _.map(results.getParsedEmails, 'id')
				Doubtful_transaction_event.find({parsed_email: pe_ids}).exec(cb);
			}],
			getTransactionEvents: ['getParsedEmails', function(results, cb){
				var te_ids=_.chain(results.getParsedEmails).map('transaction_event').filter().value();
				Transaction_event.find({id:te_ids}).populate('account').exec(cb);
			}]
		},function(err,results){
			results.getParsedEmails.forEach(function(pe){
				results.getDTEs.forEach(function(dte){
					if(dte.parsed_email == pe.id){
						pe.dte = dte;
					}
				});
				if(pe.transaction_event){
					results.getTransactionEvents.forEach(function(te){
						if(te.id==_.get(pe, 'transaction_event')){
							pe.transaction_event = te;
						}
					});
				}
			})
			
			var locals={
				parsed_emails:results.getParsedEmails,
				page: page,
				limit:limit,
				moment: moment
			}
			res.view('list_parsed_emails',locals);
		})
	},
	viewParsedEmail:function(req,res){
		Parsed_email.findOne({org:req.params.o_id,id:req.params.pe_id}).exec(function(err,pe){
			var locals={
				pe:pe
			}
			res.view('view_parsed_email',locals);
		})
	},
	retryParsedEmail: function(req, res){
		async.auto({
			getParsedEmail: function(cb){
				Parsed_email.findOne({id: req.params.id, org:req.org.id}).exec(function(err, pe){
					if(err) return cb(err);
					if(!pe || !_.get(pe, 'details.inbound')) return cb(new Error("NOT_FOUND"));
					if(pe.transaction_event) return cb(new Error('TRANSACTION_EVENT_EXIST'))
					return cb(null, pe);
				});
			},
			reParse: ['getParsedEmail', function(results, cb){
				MailgunService.parseInboundEmail(results.getParsedEmail.details.inbound,cb)
			}]	
		}, function(err, results){
			if(err){
				switch (err.message) {
					default:
						return res.status(500).json({error: err.message});
						break;
				}
			}
			return res.json({status: 'success'})
		});
	},
	createEmail:function(req,res){
		if(req.body){ // post request
			var e={
				email:req.body.email,
				org:req.org.id,
			}
			// console.log('before transaction find or create');
			console.log(e);
			Email.create(e).exec(function(err,transaction){
				if(err){
					console.log(err);
					throw err;
				}
				else
					res.redirect('/org/' + req.org.id +'/emails');
			});
		}else{ // view the form
			var locals={
				email:'',
				token:'',
				status:'',
				message:'',
			}
			console.log(locals);
			res.view('create_email',locals);
		}
	},
	editEmail:function(req,res){
	},
	listAccounts:function(req,res){
		Account.find({org:req.org.id}).exec(function(err,accounts){
			var locals={
				accounts:accounts
			}
			res.view('list_accounts',locals);
		})
	},
	viewAccount:function(req,res){
		Account.findOne({id:req.params.id,org:req.org.id}).exec(function(err,account){
			if(!account)
				return res.send('you dont have the permission to view this account');
			var questions=[
				{
					url_name:'income_expense',
					question_id:21,
				},
				{
					url_name:'transfer_in_out',
					question_id:22,
				},
				{
					url_name:'balance',
					question_id:23,
				},
			]
			var locals={
				account:account,
				metabase:{}
			}
			questions.forEach(function(q){
				var payload = {
					resource: { question: q.question_id },
				};
				if(q.url_name=='balance')
					payload.params= {account_id:""+account.id};
				else
					payload.params= {account_ids:""+account.id};
				var token = jwt.sign(payload, sails.config.metabase.secret_key);
				locals.metabase[q.url_name]=sails.config.metabase.site_url + "/embed/question/" + token + "#bordered=true&titled=false";
			});
			res.view('view_account',locals);
		})
	},
	createAccount:function(req,res){
		if(req.body){ // post request
			var findFilter={
			};
			var a={
				name:req.body.name,
				acc_number:req.body.acc_number,
				type:req.body.type,
				org:req.org.id,
			}
			// console.log('before transaction find or create');
			console.log(a);
			Account.create(a).exec(function(err,transaction){
				if(err)
					throw err;
				else
					res.redirect('/org/' + req.org.id +'/accounts');
			});
		}else{ // view the form
			var locals={
				status:'',
				message:'',
				name:'',
				acc_number:'',
				type:'',
			}
			console.log(locals);
			res.view('create_account',locals);
		}
	},
	editAccount:function(req,res){
		if(req.body){ // post request
			var findFilter={
			};
			var a={
				name:req.body.name,
				acc_number:req.body.acc_number,
				type:req.body.type,
				org:req.org.id,
			}
			// console.log('before transaction find or create');
			// console.log(a);
			Account.update({id:req.params.id},a).exec(function(err,account){
				if(err)
					throw err;
				else
					res.redirect('/org/' + req.org.id +'/accounts');
			});
		}else{ // view the form
			Account.findOne({id:req.params.id}).exec(function(err,a){
				var locals={
					status:'',
					message:'',
					name:a.name,
					acc_number:a.acc_number,
					type:a.type,
				}
				// console.log(locals);
				res.view('create_account',locals);
			});
		}
	},
	dashboard:function(req,res){
		var month=null,year=null;
		if(req.query.month){
			year=req.query.month.substring(0,4);
			month=req.query.month.substring(5,7);
		}
		else if(req.query.year)
			year= req.query.year.substring(0,4);
		else{
			year=new Date().toISOString().substring(0,4);
			month=new Date().toISOString().substring(5,7);
		}
		var start_of_month = new Date(year+'-'+month+'-'+1);
		var end_of_month = moment(start_of_month).endOf('month').toDate();

		async.auto({
			getAccounts:function(callback){
				Account.find({org:req.org.id}).sort('name ASC').exec(callback);
			},
			getCategories:function(callback){
				Category.find({org:req.org.id}).exec(callback);
			},
			getTransactionsWithOutDescription: ['getAccounts', function(results, callback){
				var accounts =  _.map(results.getAccounts,'id')
				Transaction.count({description: null, account:accounts, occuredAt:{'<':end_of_month, '>':start_of_month}}).exec(callback);
			}],
			getTransactionsWithOutCategory: ['getAccounts', function(results, callback){
				var accounts =  _.map(results.getAccounts,'id')
				Transaction.count({category: null, account:accounts, occuredAt:{'<':end_of_month, '>':start_of_month}}).exec(callback);
			}],
			getStatementsCount: function(callback){
				Statement.count({org:req.org.id}).exec(callback);
			},
			getAccountsWhereStatementsArePresentForThatMonth: ['getAccounts', function(results, callback){
				var query = `WITH sli AS (
					SELECT
						(data ->> 'date') AS sli_date,
						statement,
						statement_line_item.id,
						account_statements__statement_accounts.account_statements as account,
						org,
						statement_line_item."createdAt"
					FROM
						statement_line_item left JOIN account_statements__statement_accounts on account_statements__statement_accounts.statement_accounts = statement_line_item."statement"
				)
				SELECT
					account
				FROM
					sli where "createdAt"::date > '2019-05-01'::date and sli_date::date < '${end_of_month.toISOString().substring(0,10)}'::date AND sli_date::date > '${start_of_month.toISOString().substring(0,10)}'::date GROUP by sli.account;`
				
				sails.sendNativeQuery(query, function(err, rawResult){
					if(err)
						callback(err);
					else
						callback(err,rawResult.rows);
				})
			}],
			getCategorySpending:['getAccounts',function(results,callback){

				var escape=[year];
				var query = 'select count(*),sum(amount_inr),category from transaction';
				query+=' where';
				query+=" type='income_expense'";
				query+=' AND EXTRACT(YEAR FROM "occuredAt") = $1';
				if(month){
					escape.push(month);
					query+=' AND EXTRACT(MONTH FROM "occuredAt") = $2';
				}
				if(_.map(results.getAccounts,'id').length)
					query+=' AND account in '+GeneralService.whereIn(_.map(results.getAccounts,'id'));
				// in the accounts that belong to you
				query+=' group by category';
				sails.sendNativeQuery(query,escape,function(err, rawResult) {
					if(err)
						callback(err);
					else
						callback(err,rawResult.rows);
				});
			}],
			getUnresolvedDTEsCount: function(cb){
				Doubtful_transaction_event.count({org: req.org.id, status: null}).exec(cb);
			}
		},function(err,results){
			if(err){
				console.log(err);
				throw err;
			}
			results.getCategories.forEach(function(cat){
				cat.t_count=0;
				cat.t_sum=0;
				console.log(results.getCategorySpending);
				results.getCategorySpending.forEach(function(spend){
					if(cat.id==spend.category){
						cat.t_count=spend.count;
						cat.t_sum=-(spend.sum);
					}
				})
				// console.log(cat);
			});

			var locals={
				current:year+'-'+month,
				accounts:results.getAccounts,
				unresolved_dtes_count: results.getUnresolvedDTEsCount,
				categories:GeneralService.orderCategories(results.getCategories),
				transactions_without_category: results.getTransactionsWithOutCategory,
				transactions_without_description: results.getTransactionsWithOutDescription,
				start_of_month: start_of_month,
				end_of_month: end_of_month
			}

			locals.accounts_for_which_statements_missing = _.filter(locals.accounts, function(a){
				if(a.type == 'wallet' || a.type == 'investment' || a.type == 'cash' || a.acc_number.includes('amazon_pay'))
					return false;
				if(results.getAccountsWhereStatementsArePresentForThatMonth.indexOf(a.id) == -1)
					return true;
			});
			
			if(month==1)		
				locals.prev=(parseInt(year)-1)+'-12';		
			else		
				locals.prev=year+'-'+(parseInt(month)-1)		

			if(month==12)		
				locals.next=(parseInt(year)+1)+'-1'		
			else		
				locals.next=year+'-'+(parseInt(month)+1);
			
			res.view('dashboard',locals);
		})

	},
	listTransactions:function(req,res){
		var locals={};
		//pagination

		var limit = req.query.limit?parseInt(req.query.limit): 25;
		var page = req.query.page?parseInt(req.query.page):1;
		var skip = limit * (page-1);
		var transaction_filter;
		var query;
		//sort filter
		var sort;

		locals.page = page;
		locals.limit = limit;

		async.auto({
			getAccounts:function(callback){
				Account.find({org:req.org.id}).exec(callback);
			},
			getStatements:function(callback){ // only for filter
				Statement.find({org:req.org.id}).sort('createdAt DESC').exec(callback);
			},
			getTransactionEventsInStatement:function(callback){
				if(req.query.statement){
					Statement_line_item.find({statement:req.query.statement}).exec(callback);
				}else
					callback(null);
			},
			getCategories:function(callback){
				Category.find({org:req.org.id}).sort('name ASC').exec(callback);
			},
			getTransactions:['getAccounts','getTransactionEventsInStatement','getCategories', async function(results,callback){
				if(req.query.tags){
					query = `
					select "transaction"."id" from "transaction" LEFT JOIN 
					tag_transactions__transaction_tags on "transaction".id = tag_transactions__transaction_tags.transaction_tags 
					WHERE tag_transactions__transaction_tags.tag_transactions in (${req.query.tags}) AND`
				}else {
					query = `select "transaction"."id" from "transaction" WHERE `
				}
				//account filter
				var accounts=[];
				if(!_.isNaN(parseInt(req.query.account))){
					accounts.push(req.query.account);
				}else{
					results.getAccounts.forEach(function(account){
						accounts.push(account.id);
					});
				}
				var filter={
					account:accounts,
				}
				if(filter.account.length)
					query += ` "transaction".account in ${GeneralService.whereIn(filter.account)}`

				if(req.query.statement){
					filter.transaction_event=_.filter(_.map(results.getTransactionEventsInStatement,'transaction_event'));
					query += ` AND "transaction".transaction_event in ${GeneralService.whereIn(filter.transaction_event)}`
				}

				// category filter
				if(!_.isNaN(parseInt(req.query.category))){
					filter.category=[parseInt(req.query.category)];
					// include sub categoriess	
					if(req.query.include_subcategories == 'true'){
						_.forEach(results.getCategories, function(c){
							if(c.parent == req.query.category)
								filter.category.push(c.id);
						})
					}
					query += ` AND "transaction".category in ${GeneralService.whereIn(filter.category)}`
				}
				else if(req.query.category == 'empty'){
					filter.category = null;
					query += ` AND "transaction".category is NULL`
				}
				
				// third party filter
				if(req.query.third_party){
					filter.third_party = {contains: req.query.third_party }
					query += ` AND "transaction".third_party ILIKE '%${req.query.third_party}%'`
				}

				// description filter
				if(req.query.description){
					filter.description = {contains: req.query.description }
					query += ` AND "transaction".description ILIKE '%${req.query.description}%'`
				}


				// txn type filter
				if(req.query.txn_type){
					switch (req.query.txn_type) {
						case 'transfer':
							filter.type = 'transfer'
							query += ` AND "transaction".type = transfer`
							break;
						case 'income':
							filter.type = 'income_expense'
							filter.amount_inr = {'>':0};
							query += ` AND "transaction".type = income_expense`
							query += ` AND "transaction".amount_inr > 0`
							break;
						case 'expense':
							filter.type = 'income_expense'
							filter.amount_inr = {'<':0};
							query += ` AND "transaction".type = income_expense`
							query += ` AND "transaction".amount_inr < 0`
							break;
						default:
							break;
					}
				}

				//amount range filter
				if(!_.isNaN(parseInt(req.query.amount_less_than))){
					var amount_less_than = parseInt(req.query.amount_less_than)
					query += ` AND abs("transaction"."amount_inr") < ${amount_less_than}`

				}

				if(!_.isNaN(parseInt(req.query.amount_greater_than))){
					var amount_greater_than = parseInt(req.query.amount_greater_than)
					query += ` AND abs("transaction"."amount_inr") > ${amount_greater_than}`
				}
				
				// occured_at filter
				var date_to  = req.query.date_to ? moment(req.query.date_to, 'YYYY-MM-DD').endOf('day').tz('Asia/Kolkata').toISOString() : new Date().toISOString();
				var date_from = req.query.date_from ? moment(req.query.date_from, 'YYYY-MM-DD').tz('Asia/Kolkata').toISOString() : null;
				
				if(date_from){
					filter.occuredAt = {'>':date_from, '<': date_to }
					query += ` AND "transaction"."occuredAt" > '${date_from}'`
				}
				if(date_to){
					filter.occuredAt = {'<': date_to };
					query += ` AND "transaction"."occuredAt" < '${date_to}'`
				};			

				// id corresponds to transaction id not tcs
				if(req.query.ids){
					filter.id = _.map(req.query.ids.split(','), function (each) {
						if(parseInt(each))
							return parseInt(each);})

					query += ` AND "transaction"."id" in ${GeneralService.whereIn(filter.id)}`
				}

				//group by transaction.id if tag filter is applied.
				if(req.query.tags)
					query += ` GROUP BY "transaction"."id"`					

				if(req.query.sort){
					sort = 'occuredAt ' + req.query.sort
					query += ' ORDER BY "transaction"."occuredAt" '+ req.query.sort;
				}
				else{
					sort = 'occuredAt ' + 'DESC';
					query += ' ORDER BY "transaction"."occuredAt" DESC';
				}

				// get paginated transaction ids 
				var ts = await sails.sendNativeQuery(query + ` LIMIT ${limit} OFFSET ${skip}`);

				// quering again to retain the output format. This can be optimized
				var transactions = await Transaction.find({id:_.map(ts.rows, 'id')}).populate('tags').populate('transaction_event').populate('documents');
				return transactions;
			}],
			getTransactionsCount: ['getTransactions', async function(results, callback){
				var count_query = `select count(*) from (${query}) as t`
				return (await sails.sendNativeQuery(count_query)).rows[0].count;
			}],
			getTags:function(callback){
				Tag.find({or:[{org:req.org.id}, {type:'global'}]}).exec(callback);
			},
			getTransactionEvents:['getTransactions',function(results,callback){
				var te_ids=_.map(results.getTransactions,function(t){return t.transaction_event.id});
				Transaction_event.find({id:te_ids}).sort(sort).exec(callback);
			}],
			getParsedEmails:['getTransactions',function(results,callback){
				var te_ids=_.map(results.getTransactions,function(t){return t.transaction_event.id});
				Parsed_email.find({transaction_event:te_ids}).exec(callback);
			}],
			getSLIs:['getTransactions',function(results,callback){
				var te_ids=_.map(results.getTransactions,function(t){return t.transaction_event.id});
				Statement_line_item.find({transaction_event:te_ids}).populate('statement').exec(callback);
			}]
		},function(err,results){
			if (err)
				throw err;
			locals.transactions = results.getTransactions
			locals.pages = Math.ceil(parseFloat(results.getTransactionsCount/limit)? parseFloat(results.getTransactionsCount/limit) : 1);
			var accounts=results.getAccounts;
			locals.transaction_events=results.getTransactionEvents;
			locals.transaction_events.forEach(function(te){
				te.ts=[];
				accounts.forEach(function(account){ // expanding account in the transaction object
					if(te.account==account.id)
						te.account=account;
					if(te.to_account==account.id)
						te.to_account=account;
				});
				te.parsed_emails=[];
				results.getParsedEmails.forEach(function(pe){
					if(te.id == pe.transaction_event)
						te.parsed_emails.push(pe);
				});
				te.slis=[];
				results.getSLIs.forEach(function(sli){
					if(te.id==sli.transaction_event)
						te.slis.push(sli);
				});
			});

			locals.download_documents = '/org/' + req.org.id + '/documents'+ '?download=true&ids=';

			locals.transactions.forEach(function(t){
				accounts.forEach(function(account){ // expanding account in the transaction object
					if(t.account==account.id)
						t.account=account;
					if(t.to_account==account.id)
						t.to_account=account;
				});

				var moment = require('moment-timezone');
				t.occuredAt=moment(t.occuredAt).tz('Asia/Kolkata').format();
				var te = _.find(locals.transaction_events,{ id:t.transaction_event.id });
				te.ts.push(t);

				//append document ids to download url
				_.forEach(t.documents, function(d){
					locals.download_documents = locals.download_documents + d.id + ','
				})
			})
			
			locals.accounts=results.getAccounts;
			locals.tags=results.getTags;
			locals.statements=results.getStatements;
			locals.categories=GeneralService.orderCategories(results.getCategories);
			locals.moment=require('moment-timezone');
			locals.query_string=require('query-string');

			if(req.query.download_csv=='true'){
				const json2csv = require('json2csv').parse;
				var transactions_csv = _.cloneDeep(locals.transactions);
				_.forEach(transactions_csv, function(t){
					delete t.createdAt;
					delete t.updatedAt;
					delete t.documents;
					delete t.transaction_event;
					delete t.transaction_group;
					if(t.type != 'transfer'){
						if(t.amount_inr>0){
							t.type = 'income'
						}else{
							t.type = 'expense'
						}
					}
					t.account_number = t.account.acc_number;
					t.account_name = t.account.name;
					delete t.account;
					if(t.to_account){
						t.to_account_name = t.to_account.name;
						t.to_account_number = t.to_account.acc_number;
						delete t.to_account;
					}
					if(t.category){
						_.forEach(locals.categories, function(c){
							if(c.id == t.category){
								t.category = c.fullname
							}else if (c.children.length!=0){
								_.forEach(c.children, function(c){
									if(c.id == t.category)
										t.category = c.fullname
								})
							}
						})
					}
					if(t.tags){
						var tags_strs = ''
						_.forEach(t.tags, function(tag){
							tags_strs += tag.name+', '
						});
						tags_strs = tags_strs.slice(0, -2);//remove last comma
						t.tags = tags_strs;
					}
				});
				const csvString = json2csv(transactions_csv);
				res.setHeader('Content-disposition', `attachment; filename=${moment().format("DD_MMM_YYYY")}_transactions_filtered.csv`);
				res.set('Content-Type', 'text/csv');
				res.status(200).send(csvString);
			}
			else
				res.view('list_transactions',locals);
		});
	},
	createTransactionEvent: async function(req,res){
		Account.find({org:req.org.id}).exec(function(err,accounts){
			if(req.body){ // post request
				console.log(req.body);
				const fx = require('money');
				fx.base='INR';
				fx.rates=sails.config.fx_rates;
				var findFilter={
					createdBy:'user',
					original_currency:req.body.original_currency,
					original_amount:-(req.body.original_amount),
					// needs a bit more filtering
				};
				var tz = req.body.tz ? req.body.tz:"+05:30"
				var t={
					original_currency:req.body.original_currency,
					// original_amount:-(req.body.original_amount),
					// amount_inr:-(fx.convert(req.body.original_amount, {from: req.body.original_currency, to: "INR"})),
					occuredAt: new Date(req.body.date+' '+req.body.time+tz),
					createdBy:'user',
					// type:'income_expense',
					description:req.body.description,
					account:req.body.account_id,
					third_party:req.body.third_party
				}
				if(req.body.type=='expense'){
					t.type='income_expense';
					t.original_amount=-(req.body.original_amount);
					t.amount_inr=-(fx.convert(req.body.original_amount, {from: req.body.original_currency, to: "INR"}));
				}else if(req.body.type=='income'){
					t.type='income_expense';
					t.original_amount=(req.body.original_amount);
					t.amount_inr=(fx.convert(req.body.original_amount, {from: req.body.original_currency, to: "INR"}));
				}else if(req.body.type=='transfer'){
					t.type='transfer';
					t.original_amount=-(req.body.original_amount);
					t.amount_inr=-(fx.convert(req.body.original_amount, {from: req.body.original_currency, to: "INR"}));
					t.to_account=req.body.to_account;
				}
				// console.log('before transaction find or create');
				console.log(t);
				async.auto({
					createActivity:function(callback){
						var transaction = _.cloneDeep(t);
						transaction.account=_.find(accounts,{id:parseInt(req.body.account_id)});
						var activity={
							log: {
								t:transaction,
							},
							user: req.user.id,
							type: 'transaction__manual_create',
							org: req.org.id,
							doer_type:'user'
						};
						
						Activity.create(activity).exec(callback);
					},
					createTransactionEvent:function(callback){
						Transaction_event.create(t).exec(callback);
					}
				},function(err,results){
					if(err){
						var locals={
							occuredAt:'',
							status:'error',
							message:err.message,
							description:'',
							original_amount:'',
							original_currency:'',
							third_party:'',
							account_id:'',
							to_account:'',
							accounts:accounts,
							type:'expense',
							balance: '',
							balance_currency: 'INR'
						}
						console.log(locals);
						res.view('create_transaction_event',locals);
					}	
					else{
						if(req.body.referer && req.body.referer.includes('/transactions'))
							res.redirect(req.body.referer);
						else 
							res.redirect('/org/' + req.org.id +'/transactions');
					}
				});
				
			}else{ // view the form
				var locals={
					occuredAt:'',
					status:'',
					message:'',
					description:'',
					original_amount:'',
					original_currency:'',
					third_party:'',
					account_id:'',
					to_account:'',
					accounts:accounts,
					type:'expense',
					balance: '',
					balance_currency: 'INR'
				}
				console.log(locals);
				res.view('create_transaction_event',locals);
			}
		})
	},
	viewTransactionEvent:function(req,res){

		async.auto({
			getTransactionEvent:function(callback){
				Transaction_event.findOne({id:req.params.id}).populate('account').exec(callback);
			},
			getParsedEmails:function(callback){
				Parsed_email.find({transaction_event:req.params.id}).exec(callback);
			},
			getSLIs:function(callback){
				Statement_line_item.find({transaction_event:req.params.id}).exec(callback);
			},
			getTransactions:function(callback){
				Transaction.find({transaction_event:req.params.id}).populate('tags').populate('documents').exec(callback);
			},
			getCategories:function(callback){
				Category.find({org:req.params.o_id}).sort('name ASC').exec(callback);
			},
			getTags:function(callback){
				Tag.find({org:req.params.o_id}).sort('name ASC').exec(callback);	
			},
		},function(err,results){
			var locals={
				moment:require('moment-timezone'),
				te:results.getTransactionEvent,
				categories:GeneralService.orderCategories(results.getCategories),
				tags:results.getTags,

			}
			locals.te.parsed_emails=results.getParsedEmails;
			locals.te.slis=results.getSLIs;
			locals.te.ts=results.getTransactions;
			res.view('view_transaction_event',locals);
		})
	},
	editTransactionEvent:function(req,res){
		Account.find({org:req.org.id}).exec(function(err,accounts){
			if(req.body){ // post request
				console.log(req.body);
				const fx = require('money');
				fx.base='INR';
				fx.rates=sails.config.fx_rates;
				var t={
					original_currency:req.body.original_currency,
					// original_amount:-(req.body.original_amount),
					// amount_inr:-(fx.convert(req.body.original_amount, {from: req.body.original_currency, to: "INR"})),
					occuredAt: new Date(req.body.date+' '+req.body.time+req.body.tz),
					createdBy:'user',
					// type:'income_expense',
					description:req.body.description,
					account:req.body.account_id,
					third_party:req.body.third_party
				}
				if(req.body.type=='expense'){
					t.type='income_expense';
					t.original_amount=-(req.body.original_amount);
					t.amount_inr=-(fx.convert(req.body.original_amount, {from: req.body.original_currency, to: "INR"}));
				}else if(req.body.type=='income'){
					t.type='income_expense';
					t.original_amount=(req.body.original_amount);
					t.amount_inr=(fx.convert(req.body.original_amount, {from: req.body.original_currency, to: "INR"}));
				}else if(req.body.type=='transfer'){
					t.type='transfer';
					t.original_amount=-(req.body.original_amount);
					t.amount_inr=-(fx.convert(req.body.original_amount, {from: req.body.original_currency, to: "INR"}));
					t.to_account=req.body.to_account;
				}
				// console.log('before transaction find or create');
				console.log(t);
				Transaction_event.update({id:req.params.id},t).exec(function(err,transaction){
					if(err)
						throw err;
					else
						res.redirect('/org/' + req.org.id +'/transactions');
				});
			}else{ // view the form
				Transaction_event.findOne({id:req.params.id}).exec(function(err,t){
					var locals={
						status:'',
						message:'',
						occuredAt:new Date(t.occuredAt).toISOString(),
						description:t.description,
						original_amount:t.original_amount,
						original_currency:t.original_currency,
						third_party:t.third_party,
						account_id:t.account,
						to_account:t.to_account,
						accounts:accounts,
						// type:'expense',
						// color:'red',
					}
					if(t.type=='transfer')
						locals.type='transfer';
					else if(t.type=='income_expense'){
						if(t.original_amount<0)
							locals.type='expense';
						else
							locals.type='income';
					}
					console.log(locals);
					res.view('create_transaction_event',locals);
				});
			}
		})
	},
	deleteTransactionEvent:function(req,res){
		if(req.body && req.body.confirm){ // confirming delete
			Transaction_event.destroy({id:req.params.id}).exec(function(err,t){
				if(err)
					throw(err);
				Transaction.destroy({transaction_event: req.params.id}).exec(function(err,tc){
					if(err)
						throw(err);
					res.redirect('/org/' + req.org.id +'/transactions');
				})
			});
		}else{ // showing the warning page
			Transaction_event.findOne({id:req.params.id}).populate('account').populate('transactions').exec(function(err,t){
				t.occuredAt=new Date(t.occuredAt).toISOString();
				var locals={t:t};
				res.view('delete_transaction_event',locals);
			});
		}
	},
	// editCategoryOfTransaction(req,res){
	// 	// do you have permission to edit description of that transaction?
	// 	async.auto({
	// 		getAccounts:function(callback){
	// 			Account.find({org:req.org.id}).exec(callback);
	// 		},
	// 		getTransaction:function(callback){
	// 			Transaction.findOne({id:req.body.tc}).exec(callback);
	// 		},
	// 	},function(err,results){
	// 		if(err)
	// 			throw err;
	// 		var t = results.getTransaction;
	// 		var flag=false;
	// 		results.getAccounts.forEach(function(account){
	// 			if(t.account==account.id) // transaction in account of the user
	// 				flag=true;
	// 		});
	// 		if(flag){
	// 			Transaction.update({id:t.id},{description:req.body.description}).exec(function(err,result){
	// 				if(err)
	// 					throw err;
	// 				else
	// 					res.send('ok');
	// 			})
	// 		}else{
	// 			res.send(400,'you cant edit that transaction');
	// 		}
	// 	})
	// },
	editDescription:function(req,res){
		if(req.body.tc){
			// do you have permission to edit description of that transaction?
			async.auto({
				getAccounts:function(callback){
					Account.find({org:req.org.id}).exec(callback);
				},
				getTransaction:function(callback){
					Transaction.findOne({id:req.body.tc}).exec(callback);
				},
				updateTransaction:['getAccounts','getTransaction',function(results,callback){
					var t = results.getTransaction;
					var flag=false;
					results.getAccounts.forEach(function(account){
						if(t.account==account.id) // transaction in account of the user
							flag=true;
					});
					if(flag){
						Transaction.update({id:t.id},{description:req.body.description}).exec(callback);
					}else{
						callback('you cant edit that transaction');
					}
				}],
				createActivity:['updateTransaction',function(results,callback){
					// if permission is not there, this function is not called. 
					var transaction = results.getTransaction;
					transaction.account=_.find(results.getAccounts,{id:transaction.account});
					var activity={
						log: {
							t_prev:transaction,
							description_updated:req.body.description,
						},
						user: req.user.id,
						type: 'transaction__edit_desc',
						org: req.org.id,
						doer_type:'user'
					};
					
					Activity.create(activity).exec(callback);
				}]
			},function(err,results){
				if(err=='you cant edit that transaction')
					res.send(400,'you cant edit that transaction');

				if(err && err!='you cant edit that transaction')
					throw err;
				else
					res.send('ok');
			})
		}else if(req.body.doc){
			Statement.findOne({id:req.body.doc}).exec(function(err,doc){
				if(doc.org==req.org.id){
					Statement.update({id:doc.id},{description:req.body.description}).exec(function(err,result){
						if(err)
							throw err;
						else
							res.send('ok');
					});
				}else{
					res.send(400,'you cant edit that statement');
				}
			})
		}
	},
	listSnapshots:function(req,res){
		
		var locals={};
		// getUserEmailIds:function
		var limit = req.query.limit?req.query.limit:100;
		async.auto({
			getAccounts:function(callback){
				Account.find({org:req.org.id}).exec(callback);
			},
			getSnapshots:['getAccounts',function(results,callback){
				var accounts=[];
				results.getAccounts.forEach(function(account){
					accounts.push(account.id);
				});
				Snapshot.find({account:accounts}).sort('takenAt DESC').limit(limit).exec(callback);
			}],
			
		},function(err,results){
			locals.snapshots=results.getSnapshots;
			var accounts=results.getAccounts;
			locals.snapshots.forEach(function(s){
				accounts.forEach(function(account){ // expanding account in the transaction object
					if(s.account==account.id)
						s.account=account;
				});
				var moment = require('moment-timezone');
				s.takenAt=moment(s.takenAt).tz('Asia/Kolkata').format();
			})
			locals.moment=require('moment-timezone');
			res.view('list_snapshots',locals);
			
		});
	},
	createSnapshot:function(req,res){
		Account.find({org:req.org.id}).exec(function(err,accounts){
			if(req.body){ // post request
				console.log(req.body);
				const fx = require('money');
				fx.base='INR';
				fx.rates=sails.config.fx_rates;
				var findFilter={
					createdBy:'user',
					original_currency:req.body.original_currency,
					original_amount:-(req.body.original_amount),
					// needs a bit more filtering
				};
				var s={
					balance:req.body.balance,
					takenAt: new Date(req.body.date+' '+req.body.time+req.body.tz),
					createdBy:'user',
					account:req.body.account_id,
				}
				// console.log('before transaction find or create');
				console.log(s);
				Snapshot.create(s).exec(function(err,transaction){
					if(err)
						throw err;
					else
						res.redirect('/org/' + req.org.id +'/snapshots');
				});
			}else{ // view the form
				var locals={
					status:'',
					balance:'',
					takenAt:'',
					account_id:'',
					message:'',
					accounts:accounts
				}
				console.log(locals);
				res.view('create_snapshot',locals);
			}
		})
	},
	editSnapshot:function(req,res){
		Account.find({org:req.org.id}).exec(function(err,accounts){
			if(req.body){ // post request
				console.log(req.body);
				const fx = require('money');
				fx.base='INR';
				fx.rates=sails.config.fx_rates;
				var s={
					balance:req.body.balance,
					takenAt: new Date(req.body.date+' '+req.body.time+req.body.tz),
					createdBy:'user',
					account:req.body.account_id,
				}
				// console.log('before transaction find or create');
				console.log(s);
				Snapshot.update({id:req.params.id},s).exec(function(err,transaction){
					if(err)
						throw err;
					else
						res.redirect('/org/' + req.org.id +'/snapshots');
				});
			}else{ // view the form
				Snapshot.findOne({id:req.params.id}).exec(function(err,s){
					var locals={
						status:'',
						balance:s.balance,
						account_id:s.account,
						takenAt:new Date(s.takenAt).toISOString(),
						message:'',
						accounts:accounts
					}
					console.log(locals);
					res.view('create_snapshot',locals);
				});
			}
		});
	},
	deleteSnapshot:function(req,res){
		if(req.body && req.body.confirm){ // confirming delete
			Snapshot.destroy({id:req.params.id}).exec(function(err,s){
				if(err)
					throw(err);
				res.redirect('/org/' + req.org.id +'/snapshots');
			});
		}else{ // showing the warning page
			Snapshot.findOne({id:req.params.id}).populate('account').exec(function(err,s){
				s.takenAt=new Date(s.takenAt).toISOString();
				var locals={s:s};
				res.view('delete_snapshot',locals);
			});
		}
	},
	emailTest:function(req,res){
		// MailgunService.sendEmail({},function(err){
		// 	res.send('email sent');
		// })
		var options={
			start_date:new Date('2018-09-24T00:00:00.000+0530'),
			end_date:new Date('2018-10-01T00:00:00.000+0530'),
			user:req.query.user,
		}
		NotificationService.sendWeeklyEmailReport(options,function(err,result){
			if(err)
				throw err;
			res.send(result);
		})
	},
	listStatements: function(req, res){
		var locals={};

		//pagination
		var limit = req.query.limit?parseInt(req.query.limit): 20; //default to 20
		var page = req.query.page?parseInt(req.query.page):1;
		var skip = limit * (page-1);

		locals.page = page;
		locals.limit = limit;
		locals.skip = skip

		locals.date_gte = (req.query.date_gte) ? req.query.date_gte: moment().subtract(2, 'years').format('YYYY-MM-DD'); // defaults to 2 years
		locals.date_lte = (req.query.date_lte) ? req.query.date_lte: moment().format('YYYY-MM-DD');
		

		async.auto({
			getAccounts: function(cb){
				Account.find({org:req.org.id}).exec(function(err, accounts){
					if(err) return cb(err);
					locals.accounts = (req.query.account)? GeneralService.whereIn([req.query.account]): GeneralService.whereIn(_.map(accounts,'id'));
					return cb(null, accounts);
				});
			},
			getStatements: ['getAccounts', function(results, cb){
				var filtered_list_statements_query = `
					SELECT
					*
					FROM (
						SELECT
							"statement"."org" AS org,
							"statement"."data" as statement_data,
							"statement"."createdAt" as "statement_createdAt",
							"statement"."type" AS statement_type,
							"statement"."id" AS statement_id,
							"account"."id" AS account_id,
							"account"."name" AS account_name,
							"account"."type" AS account_type,
							"statement"."details" AS statement_details,
							"statement"."description" AS statement_description,
							data ->> 'transactions_from_date' AS transactions_from_date,
							data ->> 'transactions_to_date' AS transactions_to_date
						FROM
							"statement"
						LEFT JOIN account_statements__statement_accounts ON account_statements__statement_accounts.statement_accounts = "statement"."id"
						LEFT JOIN account ON account_statements__statement_accounts.account_statements = account.id
					WHERE
						"statement"."org" = ${req.org.id}
						AND "account_statements__statement_accounts"."account_statements" in ${locals.accounts}
						AND data ->> 'transactions_to_date' > '${locals.date_gte}'
						AND data ->> 'transactions_from_date' < '${locals.date_lte}'
						LIMIT ${locals.limit} OFFSET ${locals.skip}) AS doc
						LEFT JOIN (
							SELECT
								count(*) AS unresolved_dtes, sli.statement AS sli_statement_id
							FROM
								Doubtful_transaction_event AS dte
								INNER JOIN statement_line_item AS sli ON dte.sli = sli.id
							WHERE
								sli.org = ${req.org.id}
								AND json_extract_path(dte.details::json, 'status') IS NULL
							GROUP BY
								sli.statement) AS ut ON doc.statement_id = ut.sli_statement_id
							ORDER BY "doc"."statement_data" ->> 'transactions_to_date' DESC`
				sails.sendNativeQuery(filtered_list_statements_query, cb)
			}],
			getStatementsCount: ['getAccounts', function(results, cb){
				var statements_count = `
					SELECT
					count(*)
					FROM (
						SELECT
							"statement"."org" AS org,
							"statement"."data" as statement_data,
							"statement"."type" AS statement_type,
							"statement"."id" AS statement_id,
							"account"."id" AS account_id,
							"account"."name" AS account_name,
							"account"."type" AS account_type,
							"statement"."details" AS statement_details,
							"statement"."description" AS statement_description,
							data ->> 'transactions_from_date' AS transactions_from_date,
							data ->> 'transactions_to_date' AS transactions_to_date
						FROM
							"statement"
						LEFT JOIN account_statements__statement_accounts ON account_statements__statement_accounts.statement_accounts = "statement"."id"
						LEFT JOIN account ON account_statements__statement_accounts.account_statements = account.id
					WHERE
						"statement"."org" = ${req.org.id}
						AND "account_statements__statement_accounts"."account_statements" in ${locals.accounts}
						AND data ->> 'transactions_to_date' > '${locals.date_gte}' 
						AND data ->> 'transactions_from_date' < '${locals.date_lte}') AS doc
						LEFT JOIN (
							SELECT
								count(*) AS unresolved_dtes, sli.statement AS sli_statement_id
							FROM
								Doubtful_transaction_event AS dte
								INNER JOIN statement_line_item AS sli ON dte.sli = sli.id
							WHERE
								sli.org = ${req.org.id}
								AND json_extract_path(dte.details::json, 'status') IS NULL
							GROUP BY
								sli.statement) AS ut ON doc.statement_id = ut.sli_statement_id
					`
				sails.sendNativeQuery(statements_count, cb)
			}]
		}, function(err, results){
			if(err) return res.view('500', err);
			
			var timeline = {
				groups:[],
				items:[]
			}

			var nestedGroups = [];
			
			var orginal_statement_s3_keys = []
			_.forEach(results.getStatements.rows, function(d){

				if(d.statement_data && d.transactions_from_date && d.transactions_to_date){
					timeline.items.push({
						id: d.statement_id + '_' + d.account_id,
						content: `${d.statement_id}: ${d.statement_details.original_filename}`,
						start: d.transactions_from_date,
						end: d.transactions_to_date,
						group: d.account_id
					})
					if(!_.find(timeline.groups, {id:d.account_id}))
						timeline.groups.push({
							id: d.account_id,
							type: d.account_type,
							name: d.account_name,
							className: d.account_type,
							content: `<a href=/org/${req.org.id}/account/${d.account_id}>${d.account_name}<a><br>(${d.account_type})`
						});
				}
				if(_.get(d, 'statement_details.s3_key')){
					orginal_statement_s3_keys.push(d.statement_details.s3_key);
					orginal_statement_s3_keys.push('decrypted_' + d.statement_details.s3_key);
				}
			});
			
			//pagination
			locals.pages = parseInt(results.getStatementsCount.rows[0].count/limit)? parseInt(results.getStatementsCount.rows[0].count/limit) : 1;
			locals.statements = results.getStatements.rows;
			locals.moment = require('moment-timezone');
			locals.timeline = timeline;
			locals.accounts = results.getAccounts;

			//build the url for downloading statements
			locals.download_original_statements = _.isEmpty(req.query)? req.url + '?download=true': req.url + '&download=true'
			
			//download statements
			if(req.query.download == "true"){
				//if not statement attached, return 404
				if(!orginal_statement_s3_keys.length)
					return res.status(404).view('404');
				//set the filename
				res.attachment(moment().format('ll') + ' cashflowy statements.zip');
				var s3 = new AWS.S3({
					accessKeyId: sails.config.aws.key,
					secretAccessKey: sails.config.aws.secret,
					region: sails.config.aws.region
				});

				s3Zip
					.archive({ s3:s3, bucket: sails.config.aws.bucket, debug: true}, '', orginal_statement_s3_keys)
					.pipe(res);
				return;
			}
			res.view('list_statements',locals);
		})
	},
	viewStatement:function(req,res){
		async.auto({
			getDoc:function(callback){
				Statement.findOne({id:req.params.id, org:req.org.id}).exec(callback);
			},
			getSLIs:function(callback){
				Statement_line_item.find({statement:req.params.id}).populate('transaction_event').sort('pos ASC').exec(callback);
			},
			getDoubtfulTransactionEvents:['getSLIs',function(results,callback){
				Doubtful_transaction_event.find({sli:_.map(results.getSLIs,'id')}).exec(callback);
			}],
			getAccounts:function(callback){
				Account.find({org:req.org.id}).exec(callback);
			}
		},function(err,results){
			var unresolved_dtes=[]
			results.getDoubtfulTransactionEvents.forEach(function(dte){
				if(!dte.details.status)
					unresolved_dtes.push(_.cloneDeep(dte));
			});
			results.getDoubtfulTransactionEvents.forEach(function(dte){
				results.getSLIs.forEach(function(sli){
					if(dte.sli==sli.id){
						sli.dte=dte;
						// dt.sli=sli;
					}
				})
			});
			results.getSLIs.forEach(function(sli){
				results.getAccounts.forEach(function(account){
					if(sli.transaction_event){
						if(sli.transaction_event.account==account.id)
							sli.transaction_event.account=account;
						if(sli.transaction_event.to_account==account.id)
							sli.transaction_event.to_account=account;
					}
				})
			})
			var locals={
				doc:results.getDoc,
				slis:results.getSLIs,
				doubtful_transaction_events:results.getDoubtfulTransactionEvents,
				unresolved_dtes:unresolved_dtes,
				moment:require('moment-timezone'),
			};
			// res.send(locals);
			res.view('view_statement',locals);
		})
	},
	downloadStatement: async function(req, res){
		var statement = await Statement.findOne({ id: req.params.id, org: req.org.id });
		if (!statement) res.status(404).view('404');

		var fd =  _.get(statement, 'details.s3_key');
		var decrypted_fd = 'decrypted_' + fd;

		var filename = _.get(statement, 'details.original_filename')

		if(!fd || !filename) res.status(404).view('404');
		
		res.attachment(filename);

		// try to download the decrypted file else download the orginal file
		try{
			var downloading = await sails.startDownload(decrypted_fd);
		} catch(err){
			var downloading = await sails.startDownload(fd);
		}
		downloading.pipe(res);
	},
	createStatement: async function(req, res) {
		console.log('req.org:');
		console.log(req.org);
		var statements_string="";
		if (req.method == 'GET') {
			var locals = {
				type: '',
				message: ''
			}
			res.view('create_statement', locals)
		} else {
			var locals = {
				type: '',
				message: ''
			}
			async.auto({
				uploadFiles: function (cb) {
					req.file('file').upload(function (err, uploadedFiles) {
						if (err) return cb(err);
						cb(null, uploadedFiles)
					});
				},
				processFiles:['uploadFiles',function(results,cb){
					async.eachOf(results.uploadFiles,function(u_file,index,callback){
						async.auto({	
							uploadOriginalFileToS3:  function( cb){
								var s3 = new AWS.S3({
									accessKeyId: sails.config.aws.key,
									secretAccessKey: sails.config.aws.secret,
									region: sails.config.aws.region
								});
								var params = {Bucket: sails.config.aws.bucket, 
									Key: _.get(u_file, 'stream.fd'), 
									Body: fs.createReadStream(u_file.fd)
								};
								s3.upload(params, function(err, data) {
									cb(err, data);
								});
							},
							createStatement: ['uploadOriginalFileToS3', function (results, cb) {
								Statement.create({ 
									org: req.org.id, 
									parser_used: req.body.type, 
									details:{
										s3_key:results.uploadOriginalFileToS3.key, 
										original_filename:u_file.filename, 
										s3_location: results.uploadOriginalFileToS3.Location, 
										s3_bucket: results.uploadOriginalFileToS3.Bucket} }).exec(cb);
							}],
							removePassword: ['createStatement', async function(results){
								const pdf = require('pdf-parse');
								const util = require('util');
								const exec = util.promisify(require('child_process').exec);
								var fsExists = util.promisify(require('fs').exists);
			
								var org = await Org.findOne(req.org.id);
			
								var uf = u_file.fd.split('/')
								uf[uf.length -1] = 'decrypted_'+uf[uf.length -1];
								uf = uf.join('/');
			
								// if user enters the password try first
								if(req.body.password)
									try{
										const { stdout, stderr } = await exec(`qpdf -password=${req.body.password} -decrypt ${u_file.fd} ${uf}`);
										console.log('output', stdout, stderr);
									}
									catch(error){
										// pass
										console.log('error', error);
										throw new Error('INVALID_PASSWORD_ENTERED');
									}
			
								//else try saved passwords or no password option
								else{
									for (const sp of _.union(org.details.statement_passwords, [''])) {
										try{
											const { stdout, stderr } = await exec(`qpdf -password=${sp} -decrypt ${u_file.fd} ${uf}`);
											console.log('output', stdout, stderr);
										}
										catch(error){
											// pass
											console.log('error', error);
										}
									}
								}
								console.log('came here, should come after the for loop')
								var decrypted_file_exists = await fsExists(uf);
								if(decrypted_file_exists){
									// if worked
									if(req.body.password){
										org.details.statement_passwords = _.union(org.details.statement_passwords, [req.body.password])
										await Org.update(org.id, {details: org.details});
									}
									return uf;
								}
								else
									throw new Error('PASSWORD_DECRYPTION_FAILED');
							}],
							uploadDecryptedFileToS3: ['removePassword', function(results, cb){
								var s3 = new AWS.S3({
									accessKeyId: sails.config.aws.key,
									secretAccessKey: sails.config.aws.secret,
									region: sails.config.aws.region
								});
								var params = {Bucket: sails.config.aws.bucket, 
									Key: 'decrypted_' + _.get(u_file, 'stream.fd'), 
									Body: fs.createReadStream(results.removePassword)
								};
								s3.upload(params, function(err, data) {
									cb(err, data);
								});
							}],
							sendToDocParser: ['removePassword', function (results, cb) {
				
								var options = {
									method: 'POST',
									url: `https://${sails.config.docparser.api_key}:@api.docparser.com/v1/document/upload/${req.body.type}`,
									json:true,
									formData:
										{
											remote_id: process.env.NODE_ENV + '_' + results.createStatement.id,
											file:
												{
													value: fs.createReadStream(results.removePassword),
													options:
														{
															filename: u_file.filename,
															contentType: null
														}
												}
										}
								};
			
								request(options, function (error, response, body) {
									if (error) return cb(error);
									if(body && body.error)
										return cb(new Error(body.error));
									cb(null, body);
								});
				
							}]
						}, function(error, results){
							console.log('error:');
							console.log(error);
							console.log('results:==');
							// console.log(results);
							statements_string=statements_string+results.createStatement.id+','
							console.log('statements_string')
							console.log(statements_string)
							callback();

						})
					},function(err){
						cb(err)
					})
						
				

				}]},
				function(error, results){
					var locals ={
						type:'',
						message:''
					};
   
				   if(error){
						locals.message = error.message
						return res.view('create_statement', locals);
				   }
				   else	
				   console.log('flow completed:');
				   console.log();
				   statements_string=statements_string.substring(0, statements_string.length - 1);
					return res.redirect('/org/' + req.org.id +"/statements_status?statements=" + statements_string);
					//    return res.redirect('/org/' + req.org.id +"/statement/" + results.createStatement.id);
			   })
				
				
			
		}
	},
	editStatement:function(req,res){
		res.send('edit a statement here');
	},
	deleteStatement:function(req,res){
		res.send('delete a statement using this');
	},
	listTags:function(req,res){
		Tag.find({org:req.org.id}).exec(function(err,tags){
			var locals={
			tags:tags
			}
			res.view('list_tags',locals);
		});
	},
	createTag:function(req,res){
		if(req.body){ // post request

			var t={
				name:req.body.name,
				description:req.body.description,
				org:req.org.id,
				type:'user',
			}
			console.log(t);
			Tag.create(t).exec(function(err,tag){
				if(err){
					console.log(err);
					throw err;
				}
				else
					res.redirect('/org/' + req.org.id +'/tags');
			});
		}else{ // view the form
			var locals={
				status:'',
				message:'',
				name:'',
				description:'',
			}
			console.log(locals);
			res.view('create_tag',locals);
		}
	},
	viewTag:async function(req,res){
		var tag = await Tag.findOne({id:req.params.id, org: req.org.id});
		if(!tag)
			return res.view('404');
		
		var accounts = await Account.find({org: req.org.id});

		var query = `SELECT sum (case when transaction.amount_inr >= 0 then transaction.amount_inr else 0 end) as income, sum (case when transaction.amount_inr < 0 then transaction.amount_inr else 0 end) as expense from transaction left JOIN tag_transactions__transaction_tags on transaction.id = tag_transactions__transaction_tags.transaction_tags WHERE tag_transactions__transaction_tags.tag_transactions = $1 and transaction."type" = 'income_expense'`
		var income_expense = (await sails.sendNativeQuery(query, [tag.id])).rows[0];

		var date_filter = `date_trunc('week', NOW()) = date_trunc('week', "transaction"."occuredAt"::date)`;
		if(req.query.time_span == 'this-month'){
			date_filter = `date_trunc('month', NOW()) = date_trunc('month', "transaction"."occuredAt"::date)`;
		} else if(req.query.time_span == 'this-year'){
			date_filter = `date_trunc('year', NOW()) = date_trunc('year', "transaction"."occuredAt"::date)`;
		}
		var filter_query = `SELECT sum (case when transaction.amount_inr >= 0 then transaction.amount_inr else 0 end) as income, sum (case when transaction.amount_inr < 0 then transaction.amount_inr else 0 end) as expense from transaction left JOIN tag_transactions__transaction_tags on transaction.id = tag_transactions__transaction_tags.transaction_tags WHERE tag_transactions__transaction_tags.tag_transactions = $1 and transaction."type" = 'income_expense' and ` + date_filter
		var filtered_income_expense = (await sails.sendNativeQuery(filter_query, [tag.id])).rows[0];

		var locals = {
			tag: tag,
			total_income: income_expense.income,
			total_expense: income_expense.expense,
			filtered_income: filtered_income_expense.income ? filtered_income_expense.income: 0,
			filtered_expense: filtered_income_expense.expense ? filtered_income_expense.expense: 0,
			metabase: {}
		}
		var questions=[
			{
				url_name:'category_wise_expense',
				question_id:30,
				params:{
					tag_id:""+tag.id,
				}
			},
			{
				url_name:'category_wise_income',
				question_id:31,
				params:{
					tag_id:""+tag.id,
				}
			}
		]
		questions.forEach(function(q){
			var payload = {
				resource: { question: q.question_id },
				params:q.params,
			};
			var token = jwt.sign(payload, sails.config.metabase.secret_key);
			locals.metabase[q.url_name]=sails.config.metabase.site_url + "/embed/question/" + token + "#bordered=true&titled=false";
		});
		res.view('view_tag',locals);
	},
	editTag:function(req,res){
		Tag.findOne({org:req.org.id,id:req.params.id}).exec(function(err,tag){
			if(err)
				throw err;
			if(!tag)
				return res.send('No tag with this id or you dont have permission to edit this tag');
			console.log(tag);
			if(req.body){ // post request
				var t={
					name:req.body.name,
					description:req.body.description,
					org:req.org.id,
				}
				console.log(t);
				Tag.update({id:req.params.id},t).exec(function(err,transaction){
					if(err)
						throw err;
					else
						res.redirect('/org/' + req.org.id +'/tags');
				});
			}else{ // view the form
				var locals={
					status:'',
					message:'',
					name:tag.name,
					description:tag.description,
				}
				console.log(locals);
				res.view('create_tag',locals);
			}
		});
	},
	editTags:function(req,res){
		async.auto({
			getAllTags:function(callback){
				Tag.find({or:[{org:req.org.id},{type:'global'}]}).exec(callback);
			},
			getTransaction:function(callback){
				// console.log(req.body);
				Transaction.findOne({id:req.body.t_id}).populate('tags').exec(callback);
			}
		},function(err,results){
			var org_tag_ids=_.map(results.getAllTags, 'id');
			var requested_tag_ids = _(req.body.new_tags).filter(function(t){return parseInt(t)}).map(function(t){return parseInt(t);}).value()
			var tag_ids_to_replace = _.intersection(org_tag_ids, requested_tag_ids)
			Transaction.replaceCollection(results.getTransaction.id, 'tags').members(tag_ids_to_replace).exec(function(err, txn){
				Transaction.findOne({id:req.body.t_id}).populate('tags').exec(function(err,new_t){
					res.view('partials/display_tags', {tags: new_t.tags,layout:false});
				});
			});
		});
	},
	listDoubtfulTransactionEvent: function(req, res){
		var locals = {
			moment:  moment
		};
		var filter = {
			org: req.org.id
		}
		if(req.query.status)
			filter.status = req.query.status;
		if(req.query.status == 'unresolved')
			filter.status = null;
			
		async.auto({
			getAccounts: function(cb){
				Account.find({org: req.org.id}).exec(cb);
			},
			getDTEs: function(cb){
				Doubtful_transaction_event.find(filter).sort('createdAt DESC').exec(cb);
			}
		}, function(err, results){
			results.getDTEs.forEach(function(dte){
				results.getAccounts.forEach(function(account){
					if(account.id==dte.transaction_event.account)
						dte.transaction_event.account=account;
				});
			})
			locals.dtes = results.getDTEs
			res.view('list_doubtful_transaction_event', locals);
		});
	},
	viewDoubtfulTransactionEvent:function(req,res){
		async.auto({
			getDTE:function(callback){
				Doubtful_transaction_event.findOne({id:req.params.id}).exec(callback);
			},
			getAccounts:['getDTE',function(results,callback){
				var dte = results.getDTE;
				var account_ids = _.map(dte.similar_transaction_events,'account');
				var to_account_ids = _.map(dte.similar_transaction_events,'to_account');
				account_ids.push(dte.transaction_event.account);
				to_account_ids.forEach(function(acc){
					if(acc)
						account_ids.push(acc);
				});

				console.log(account_ids);
				Account.find({id:account_ids}).exec(callback);
			}]
		},function(err,results){
			
			results.getAccounts.forEach(function(account){
				if(account.id==results.getDTE.transaction_event.account)
					results.getDTE.transaction_event.account=account;
			});
			results.getDTE.similar_transaction_events.forEach(function(st){
				results.getAccounts.forEach(function(account){
					if(account.id==st.account)
						st.account=account;
					if(account.id==st.to_account)
						st.to_account=account;
				});
			})

			var locals={
				dte:results.getDTE,
				moment:require('moment-timezone'),
			};
			res.view('view_doubtful_transaction_event',locals);
		})
	},
	markDTEAsUnique:function(req,res){
		async.auto({
			getDTE:function(callback){
				Doubtful_transaction_event.findOne({id:req.params.id}).exec(callback);
			},
			createTransactionEvent:['getDTE',function(results,callback){
				var t = results.getDTE.transaction_event;
				Transaction_event.create(t).exec(callback);
			}],
			updateDoubtfulTransactionEvent:['getDTE','createTransactionEvent',function(results,callback){
				var dte = results.getDTE;
				dte.status='unique';
				if(!dte.details)
					dte.details={};
				dte.details.related_txn_id=results.createTransactionEvent.id;
				Doubtful_transaction_event.update({id:dte.id},{details:dte.details, status: dte.status}).exec(callback);
			}],
			updateSLI:['getDTE','createTransactionEvent',function(results,callback){
				if(!results.getDTE.sli) return callback(null);
				var sli_id = results.getDTE.sli;
				Statement_line_item.update({id:sli_id},{transaction_event:results.createTransactionEvent.id}).exec(callback);
			}],
			updateParsedEmail:['getDTE','createTransactionEvent',function(results,callback){
				if(!results.getDTE.parsed_email) return callback(null);
				var pe_id = results.getDTE.parsed_email;
				Parsed_email.update({id:pe_id},{transaction_event:results.createTransactionEvent.id}).exec(callback);
			}]
		},function(err,results){
			if(err)
				throw err;
			if(req.header('Referer'))
				res.redirect(req.header('Referer'));
			else
				res.send('new transaction is created');
		})
	},
	markDTEAsDuplicate:function(req,res){
		async.auto({
			getDTE:function(callback){
				Doubtful_transaction_event.findOne({id:req.params.id}).exec(callback);
			},
			updateDoubtfulTransactionEvent:['getDTE',function(results,callback){
				var dte = results.getDTE;
				dte.status='duplicate';
				if(!dte.details)
					dte.details={};
				dte.details.related_txn_id=req.params.orig_txn_id;
				Doubtful_transaction_event.update({id:dte.id},{details:dte.details, status: dte.status}).exec(callback);
			}],
			updateSLI:['getDTE',function(results,callback){
				if(!results.getDTE.sli) return callback(null);
				var sli_id = results.getDTE.sli;
				Statement_line_item.update({id:sli_id},{transaction_event:req.params.orig_txn_id}).exec(callback);
			}],
			updateParsedEmail:['getDTE',function(results,callback){
				if(!results.getDTE.parsed_email) return callback(null);
				var pe_id = results.getDTE.parsed_email;
				Parsed_email.update({id:pe_id},{transaction_event:req.params.orig_txn_id}).exec(callback);
			}]
		},function(err,results){
			if(err)
				throw err;
			if(req.header('Referer'))
				res.redirect(req.header('Referer'));
			else
				res.send('marked as duplicate');
		})
	},
	listRules:function(req,res){
		Rule.find({org:req.org.id}).exec(function(err, rules){
			var locals={
				rules:rules
			}
			res.view('list_rules',locals);
		})
	},
	createRule:function(req,res){
		Rule.create({org:req.org.id, status: 'draft', type:'user', description:'rule #drafted'}).exec(
			function(err, r){
				if(err) return res.view('500', err);
				res.redirect('/org/' + req.org.id +`/rule/${r.id}/edit`);
			})
	},
	editRule:function(req,res){
		async.auto({
			findRule: function(cb){
				Rule.findOne({org:req.org.id, id: req.params.id}).exec(cb)
			},
			getAccounts: function(cb){
				Account.find({org:req.org.id}).exec(cb);
			},
			getTags: function(cb){
				Tag.find({or:[{org:req.org.id},{type:'global'}]}).exec(cb);
			},
			getCategories: function(callback){
				Category.find({org:req.org.id}).sort('name ASC').exec(callback);
			}
		},function(err, results){
			if(err) return res.serverError(err);
			if(!results.findRule) return res.view('404');
			var orderedCategories=GeneralService.orderCategories(results.getCategories);

			if(req.body){
				var update = _.pick(req.body, ['trigger' , 'action', 'description', 'status', 'type']);
				var details = _.omit(req.body, ['trigger' , 'action', 'description', 'status', 'type']);
				_.forEach(details, function(v, k){
					if(v)
						_.set(update, k, v);
				});
				Rule.update({id: results.findRule.id, org:req.org.id}, update).exec(function(err, u_r){
					if(err) return res.serverError(err);
					if(!u_r.length) return res.view('404');
					var locals = {
						rule: u_r[0],
						accounts: results.getAccounts,
						tags: results.getTags,
						categories: orderedCategories
					}
					res.view('create_rule', locals);
				})
			}else{
				var locals = {
					rule: results.findRule,
					accounts: results.getAccounts,
					tags: results.getTags,
					categories: orderedCategories
				}
				res.view('create_rule', locals);
			}
		});
	},
	listPnLs:function(req,res){
		async.auto({
			getPnls:function(callback){
				Pnl.find({org:req.org.id}).exec(callback);
			}
		},function(err,results){
			var locals={
				pnls:results.getPnls
			}
			res.view('list_pnls',locals);
		})
	},
	createPnL:function(req,res){
		var locals={
			sub:{},
			pnl:{},
			status:'',
			message:'',
		}
		if(req.body){
			var pnl={
				org:req.org.id,
				name:req.body.name,
				type:'single_pnl_head',
				details:{
					pnl_head:1 // id of the category
				}

			}
			Pnl.create(pnl).exec(function(err,result){
				res.redirect('/org/' + req.org.id +'/pnls');
			})
		}else{
			async.auto({
				getCategories:function(callback){
					Category.find({org:req.org.id}).sort('name ASC').exec(callback);
				},
			},function(err,results){
				var categories = GeneralService.orderCategories(results.getCategories);
				var head = Math.floor(Math.random() * categories.length);
				locals.pnl.statement={
					head:[
						{
							cat_id_is:categories[head].id,
							name:categories[head].name
						}
					],
					income:[],
					expense:[],
				}
				categories[head].children.forEach(function(c_cat){
					if(c_cat.type=="income"){
						locals.pnl.statement.income.push({
							cat_id_id:c_cat.id,
							name:c_cat.name
						});
					}else if(c_cat.type=='expense'){
						locals.pnl.statement.expense.push({
							cat_id_id:c_cat.id,
							name:c_cat.name
						});
					}
				})
				res.view('create_pnl',locals);
			});
		}
	},
	editPnL:function(req,res){
		var locals={}
		res.view('create_pnl',locals);
	},
	indexPnL:function(req,res){
		locals={};
		Pnl.findOne({id:req.params.id}).exec(function(err,pnl){
			if(err)
				throw err;
			console.log(pnl);
			locals.pnl=pnl;
			res.view('index_pnl',locals);
		})
	},
	viewPnL:function(req,res){
		var locals={
			pnl:{}
		}

		if(!req.query.date_from)
			req.query.date_from='2018-04-01';
		if(!req.query.date_to)
			req.query.date_to='2019-04-01';

		async.auto({
			getAccounts:function(callback){
				Account.find({org:req.org.id}).sort('name ASC').exec(callback);
			},
			getAllCategories:function(callback){
				Category.find({org:req.org.id}).exec(callback);
			},
			
			getPnl:function(callback){
				Pnl.findOne({id:req.params.id}).exec(callback);
			},
			getInvoices:['getPnl',function(results,callback){
				var filter = { 
					org: req.org.id,
					date: {
						'<': req.query.date_to,
						'>': req.query.date_from,
					},
					is_paid_fully:false,
				};
				if(results.getPnl.type=='single_pnl_head')
					filter.category=results.getPnl.details.pnl_head_category;


				Invoice.find(filter).sort('date').exec(callback);
			}],
			getCategorySpendingPerMonth:['getAccounts',function(results,callback){

				var escape=[req.query.date_from,req.query.date_to];
				var query = 'select count(*),sum(amount_inr),EXTRACT(YEAR FROM "occuredAt") as "year",EXTRACT(MONTH FROM "occuredAt") as "month",category from transaction';
				query+=' where';
				query+=" type='income_expense'";
				query+= ' AND CAST("occuredAt" AS date) BETWEEN CAST($1 AS date) AND CAST($2 AS date)';
					
				if(_.map(results.getAccounts,'id').length)
					query+=' AND account in '+GeneralService.whereIn(_.map(results.getAccounts,'id'));
				// in the accounts that belong to you
				query+=' group by category, "year", "month"';
				query+=' order by "year" , "month" '
				// console.log(query);
				sails.sendNativeQuery(query,escape,function(err, rawResult) {
					if(err)
						callback(err);
					else
						callback(err,rawResult.rows);
				});
			}],
		},function(err,results){
			if(err)
				throw err;
			
			results.getAllCategories.forEach(function(c){
				c.data={};
			})
			// generate time periods
			var time_periods = PnLService.generateTimePeriods(results.getCategorySpendingPerMonth);
			// calculate category spending per time period
			var categories_by_time = PnLService.calculateCategorySpendingPerTimePeriod(results.getAllCategories, time_periods, results.getCategorySpendingPerMonth);
			// general scafolding for pnl
			locals.pnl = PnLService.generatePnLScafolding(results.getPnl);
			// set headers for this pnl
			time_periods.forEach(function (tp) {
				locals.pnl.header.level_1.push(tp.year + '-' + tp.month);
			});
			// var a = {}
			// console.log(a.name);
			// console.log(a.name.something)
			
			if (results.getPnl.type == 'single_pnl_head') {
				locals.pnl.header.level_2.push(_.find(categories_by_time[locals.pnl.header.level_1[0]], { id: results.getPnl.details.pnl_head_category }).name);
				// generate rows scafolding for single_pnl_heads
				locals.pnl.body = PnLService.generateRowScafoldingForSinglePNLHead(results.getAllCategories, locals.pnl.details.pnl_head_category);
				// filling data
				locals.pnl.body = PnLService.populateDataForSinglePNLHead(locals.pnl.body, categories_by_time, results.getPnl.details.pnl_head_category);
			}else if(results.getPnl.type=='multiple_pnl_heads'){
				categories_by_time[locals.pnl.header.level_1[0]].forEach(function(c){
					if(c.type='pnl_head'){
						locals.pnl.header.level_2.push(c.name);
					}
				})
				// generate rows scafolding for single_pnl_heads
				locals.pnl.body = PnLService.generateRowScafoldingForMultiplePNLHeads(results.getAllCategories);
				// filling data
				locals.pnl.body = PnLService.populateDataForMultiplePNLHeads(locals.pnl.body, categories_by_time);
			}
			locals.invoices=results.getInvoices;
			res.view('view_pnl',locals);
		});
	},
	deletePnL:function(req,res){
		var locals={}
		res.view('delete_pnl',locals);
	},
	listInvoices:function(req,res){
		var locals={};
		var filters = {
			org:req.org.id
		}
		//filter for category
		if(req.query.category)
			filters.category = req.query.category;
		if(req.query.type)
			filters.type = req.query.type;
		
		// filter based in id
		if(req.query.ids){
			filters.id = {in: _.map(req.query.ids.split(','), function (each) {
				if(parseInt(each))
					return parseInt(each);
			})}
		}

		Invoice.find(filters).populate('category').sort('date DESC').exec(function(err,invoices){
			if(err)
				throw err;
			locals.invoices=invoices;
			res.view('list_invoices',locals);
		})
	},
	viewInvoice:function(req,res){
		var locals={};
		res.view('view_invoices',locals);
	},
	createInvoice:function(req,res){
		Account.find({ org:req.org.id }).exec(function (err, accounts) {
			if (req.body) { // post request
				console.log(req.body);
				const fx = require('money');
				fx.base = 'INR';
				fx.rates = sails.config.fx_rates;
				var invoice = {
					original_currency: req.body.original_currency,
					date: new Date(req.body.date + ' ' + req.body.time + req.body.tz),
					createdBy: 'user',
					description: req.body.description,
					account: req.body.account_id,
					third_party: req.body.third_party,
					type:req.body.type,
					terms:req.body.terms,
					org:req.org.id,
					remote_id:req.body.remote_id,
				}
				if (req.body.type == 'payable') {
					invoice.original_amount = -(req.body.original_amount);
					invoice.amount_inr = -(fx.convert(req.body.original_amount, { from: invoice.original_currency, to: "INR" }));
					invoice.sub_total_inr = -(fx.convert(req.body.sub_total, { from: invoice.original_currency, to: "INR" }));
					invoice.gst_total_inr = -(fx.convert(req.body.gst_total, { from: invoice.original_currency, to: "INR" }));
					invoice.balance_due_inr = -(fx.convert(req.body.balance_due, { from: invoice.original_currency, to: "INR" }));
				} else if (req.body.type == 'receivable') {
					invoice.original_amount = (req.body.original_amount);
					invoice.amount_inr = (fx.convert(req.body.original_amount, { from: invoice.original_currency, to: "INR" }));
					invoice.sub_total_inr = (fx.convert(req.body.sub_total, { from: invoice.original_currency, to: "INR" }));
					invoice.gst_total_inr = (fx.convert(req.body.gst_total, { from: invoice.original_currency, to: "INR" }));
					invoice.balance_due_inr = (fx.convert(req.body.balance_due, { from: invoice.original_currency, to: "INR" }));
				}
				// console.log('before transaction find or create');
				console.log(invoice);
				Invoice.create(invoice).exec(function (err, inv) {
					if (err)
						throw err;
					else {
						res.redirect('/org/' + req.org.id +'/invoices');
					}
				});
			} else { // view the form
				var locals = {
					invoice: {
						date: '',
					},
					accounts:accounts,
				};
				res.view('create_invoice', locals);
			}
			
		})
		
		
	},
	editInvoice:function(req,res){
		Account.find({ org: req.org.id }).exec(function (err, accounts) {
			if (req.body) { // post request
				console.log(req.body);
				const fx = require('money');
				fx.base = 'INR';
				fx.rates = sails.config.fx_rates;
				var invoice = {
					original_currency: req.body.original_currency,
					date: new Date(req.body.date + ' ' + req.body.time + req.body.tz),
					createdBy: 'user',
					description: req.body.description,
					account: req.body.account_id,
					third_party: req.body.third_party,
					type: req.body.type,
					terms: req.body.terms,
					org: req.org.id,
					remote_id: req.body.remote_id,
				}
				// if (req.body.type == 'payable') {
				// 	invoice.original_amount = -(req.body.original_amount);
				// 	invoice.amount_inr = -(fx.convert(req.body.original_amount, { from: invoice.original_currency, to: "INR" }));
				// 	invoice.sub_total_inr = -(fx.convert(req.body.sub_total, { from: invoice.original_currency, to: "INR" }));
				// 	invoice.gst_total_inr = -(fx.convert(req.body.gst_total, { from: invoice.original_currency, to: "INR" }));
				// 	invoice.balance_due_inr = -(fx.convert(req.body.balance_due, { from: invoice.original_currency, to: "INR" }));
				// } else if (req.body.type == 'receivable') {
					invoice.original_amount = (req.body.original_amount);
					invoice.amount_inr = (fx.convert(req.body.original_amount, { from: invoice.original_currency, to: "INR" }));
					invoice.sub_total_inr = (fx.convert(req.body.sub_total, { from: invoice.original_currency, to: "INR" }));
					invoice.gst_total_inr = (fx.convert(req.body.gst_total, { from: invoice.original_currency, to: "INR" }));
					invoice.balance_due_inr = (fx.convert(req.body.balance_due, { from: invoice.original_currency, to: "INR" }));
				// }
				// console.log('before transaction find or create');
				console.log(invoice);
				Invoice.update({id:req.params.i_id},invoice).exec(function (err, invoice) {
					if (err)
						throw err;
					else {
						res.redirect('/org/' + req.org.id + '/invoices');
					}
				});
			} else { // view the form
				Invoice.findOne({id:req.params.i_id}).exec(function(err,invoice){
					invoice.sub_total = (fx.convert(invoice.sub_total_inr, { to: invoice.original_currency, from: "INR" }));
					invoice.gst_total = (fx.convert(invoice.gst_total_inr, { to: invoice.original_currency, from: "INR" }));
					invoice.balance_due = (fx.convert(invoice.balance_due_inr, { to: invoice.original_currency, from: "INR" }));
					if(err)
						throw err;
					var locals = {
						invoice: invoice,
						accounts: accounts,
					};
					res.view('create_invoice', locals);
				})
				
			}

		})
	},
	deleteInvoice:function(req,res){
		var locals = {};
		res.view('delete_invoice', locals);
	},
	listBalanceSheets: function (req, res) {
		var locals = {};
		// Invoice.find({ org:req.org.id }).populate('category').exec(function (err, invoices) {
		// 	if (err)
		// 		throw err;
		// 	locals.invoices = invoices;
		// 	res.view('list_invoices', locals);
		// })
		res.view('list_balance_sheets',locals);
	},
	viewBalanceSheet: function (req, res) {
		var locals = {
			pnl: {}
		}
		if (!req.query.date_from)
			req.query.date_from = '2018-04-01';
		if (!req.query.date_to)
			req.query.date_to = '2019-04-01';

		async.auto({
			getAccounts: function (callback) {
				Account.find({ org: req.org.id }).sort('name ASC').exec(callback);
			},
			getSnapshots:['getAccounts', function (results,callback) {
				var acc_ids=_.map(results.getAccounts,'id');
				Snapshot.find({ id:acc_ids }).exec(callback);
			}],
			getAllCategories: function (callback) {
				Category.find({ org: req.org.id }).exec(callback);
			},
			// getPnl: function (callback) {
			// 	Pnl.findOne({ id: req.params.id }).exec(callback);
			// },
			getBS: function (callback) {
				Balance_sheet.findOne({ id: req.params.id }).exec(callback);
			},
		}, function (err, results) {
			if (err)
				throw err;

			results.getAllCategories.forEach(function (c) {
				c.data = {};
			})
			// generate time periods
			// var time_periods = PnLService.generateTimePeriods(results.getCategorySpendingPerMonth);
			// calculate category spending per time period
			// var categories_by_time = PnLService.calculateCategorySpendingPerTimePeriod(results.getAllCategories, time_periods, results.getCategorySpendingPerMonth);
			// general scafolding for pnl
			locals.b_s = BalanceSheetService.generateBSScafolding(results.getBS);
			// set headers for this pnl
			// time_periods.forEach(function (tp) {
			// 	locals.b_s.header.level_1.push(tp.year + '-' + tp.month);
			// });
			locals.b_s.header.level_1.push('2019-04');
			locals.b_s.header.level_2.push('all');
			// var a = {}
			// console.log(a.name);
			// console.log(a.name.something)

			if (results.getBS.type == 'single_pnl_head') {
				// locals.b_s.header.level_2.push(_.find(categories_by_time[locals.b_s.header.level_1[0]], { id: results.getPnl.details.pnl_head_category }).name);
				// // generate rows scafolding for single_pnl_heads
				locals.b_s.body = BalanceSheetService.generateRowScafoldingForSinglePNLHead(results.getAccounts, locals.b_s.details.pnl_head_category);
				// // filling data
				locals.b_s.body.forEach(function (row_l1) { // income, expense, surplus
					var row_l1_sum=0;
					row_l1.children.forEach(function (row_l2) { // bank, wallet, credit_card
						var row_l2_sum = 0;
						row_l2.children.forEach(function (row_l3) { // bank, wallet, credit_card
							row_l2_sum += row_l3.data['2019-04__all'];
						});
						row_l2.data['2019-04__all']=row_l2_sum;
						row_l1_sum += row_l2.data['2019-04__all'];
					});
					row_l1.data['2019-04__all'] = row_l1_sum;
					if (row_l1.name == 'Surplus') { // custom calculation for surplus
						row_l1.data['2019-04__all'] = locals.b_s.body[0].data['2019-04__all'] + locals.b_s.body[1].data['2019-04__all'];
					}
				})
				// locals.b_s.body = BalanceSheetService.populateDataForSinglePNLHead(locals.b_s.body, results.getAccounts, results.getPnl.details.pnl_head_category);
			}
			res.view('view_balance_sheet', locals);
		});
	},
	createBalanceSheet: function (req, res) {
		var locals = {
			sub: {},
			pnl: {},
			status: '',
			message: '',
		}
		if (req.body) {
			var pnl = {
				org: req.org.id,
				name: req.body.name,
				type: 'single_pnl_head',
				details: {
					pnl_head: 1 // id of the category
				}

			}
			Balance_sheet.create(pnl).exec(function (err, result) {
				res.redirect('/org/' + req.org.id + '/balance_sheets');
			})
		} else {
			async.auto({
				getCategories: function (callback) {
					Category.find({ org: req.org.id }).sort('name ASC').exec(callback);
				},
			}, function (err, results) {
				var categories = GeneralService.orderCategories(results.getCategories);
				var head = Math.floor(Math.random() * categories.length);
				locals.pnl.statement = {
					head: [
						{
							cat_id_is: categories[head].id,
							name: categories[head].name
						}
					],
					income: [],
					expense: [],
				}
				categories[head].children.forEach(function (c_cat) {
					if (c_cat.type == "income") {
						locals.pnl.statement.income.push({
							cat_id_id: c_cat.id,
							name: c_cat.name
						});
					} else if (c_cat.type == 'expense') {
						locals.pnl.statement.expense.push({
							cat_id_id: c_cat.id,
							name: c_cat.name
						});
					}
				})
				res.view('create_balance_sheet', locals);
			});
		}
		
	},
	editBalanceSheet: function (req, res) {
		var locals = {};
		res.view('create_balance_sheet', locals);
	},
	deleteBalanceSheet: function (req, res) {
		var locals = {};
		res.view('delete_balance_sheet', locals);
	},
	// list orgs that loggedin user is part of
	listOrgs: function (req, res) {
		var locals = {};
		Member.find({ org:req.org.id }).populate('org').exec(function (err, memberships) {
			if (err)
				throw err;
			locals.memberships = memberships;
			res.view('list_orgs', locals);
		})
	},
	viewOrg: function (req, res) {
		var locals = {};
		res.view('view_org', locals);
	},
	createOrg: async function (req, res) {
		var locals = {
			message:''
		};
		var domain = sails.config.mailgun.domain;
		if(req.body){
			var org= req.body;
			org.owner=req.user.id;
			org.email = req.body.email? req.body.email +'@'+domain: req.body.email;

			locals.org = org;

			var notify = {};
			notify.type = 'created';
			notify.user = req.user.id;
			notify.body = new String(req.user.name+' '+notify.type+' Organisation '+ req.body.name);

			try{
				var o = await Org.create(org)
				.intercept('E_UNIQUE', ()=>{ return new Error('There is already an Org using that email address!') });
				if(org.email)
					await MailgunService.createSmtpCredential({email:org.email});
					notify.org = o.id;
					await Notification.create(notify);
					// await NotificationService.sendPushNotification({notify:notify});
				return res.redirect('/org/'+o.id+'/dashboard');
			}catch(err){
				locals.message = err.message;
				return res.view('create_org', locals);
			}
		}else{
			locals.org={};
			return res.view('create_org', locals);
		}
	},
	editOrg: async function (req, res) {
		var locals = {
			message:''
		};
		var org = await Org.findOne(req.org.id);
		locals.org = org;
		if(!org)
			res.view('404');

		if(req.body){
			var req_email = req.body.email ? req.body.email + '@' + sails.config.mailgun.domain: null;
			//Email once created, cannot be changed
			if(req_email && org.email && req_email != org.email){
				locals.message = 'Email once created, cannot be changed';
				return res.view('create_org', locals);
			}
			try{
				var updated = await Org.update(org.id,{name: req.body.name, description: req.body.description, type: req.body.type, email:req_email})
				.intercept('E_UNIQUE', ()=>{ return new Error('There is already an Org using that email address!') });

				locals.org = updated[0];
				//udate in mailgun if a new email id is added
				if(req_email)
					await MailgunService.createSmtpCredential({email:req_email});
			}catch(err){
				locals.message = err.message;
			}
		}
		res.view('create_org', locals);
	},
	deleteOrg: function (req, res) {
		var locals = {};
		res.view('delete_org', locals);
	},
	listMembers: function (req, res) {
		var locals = {};
		Member.find({ org:req.params.o_id }).populate('user').populate('org').exec(function (err, members) {
			if (err)
				throw err;
			locals.owner = _.remove(members, function(m){return req.org.owner == m.user.id})[0];	
			locals.members = members;
			res.view('list_members', locals);
		});
	},
	viewMember: function (req, res) {
		var locals = {};
		res.view('view_member', locals);
	},
	createMember: async function (req, res) {
		var locals = {
			status: '',
			message: '',
			email: '',
			type: ''
		};
		if(req.body){
			var user = await User.findOne({email: req.body.email});
			if(!user){
				locals.status = 'error';
				locals.message = "user doesn't exist with the email id"
				return res.view('create_member', locals);
			}
			var create= {
				type: req.body.type,
				user: user.id,
				org: req.params.o_id
			}
			var member = await Member.findOne({
				user: user.id,
				org: req.params.o_id});

			if(member){
				locals.status = 'error';
				locals.message = "member alread exists"
				return res.view('create_member', locals);
			}
				
			Member.create(create).exec(function(err){
				if(err)
					{
						locals.status = 'error';
						locals.message = err.message;
						return res.view('create_member', locals);
					}
				return res.redirect('/org/'+req.params.o_id+'/members');
			})
		}else{
			return res.view('create_member', locals);
		}
	},
	editMember: function (req, res) {
		var locals = {};
		res.view('create_member', locals);
	},
	deleteMember: async function (req, res) {
		var locals = {};
		var member = await Member.findOne(req.params.id);
		if(!member)
			return res.status(404).json({error: 'member not found'});
		if(req.org.owner == member.user)
			return res.status(400).json({error: "can't revoke the membership of owner"})
		await Member.destroy(req.params.id);
		return res.json({status:'success'});
	},
	listSettings: function(req, res){
		var locals = {};
		res.view('list_settings', locals);
	},

	listNotifications: async function(req, res){
		var locals={
			title:'Notifications',
			description:'Notification',
			layout:'layout',
			notifications:{}		
		}

		var last_seen_noti_time;
		if(req.user.details.notifications)
			last_seen_noti_time=req.user.details.notifications.last_seen_noti_time;
		else{
			req.user.details.notifications={};
			last_seen_noti_time='2017-01-01T00:00:00.000Z';	
		}

		locals.notifications.unseen = await Notification.find({user:req.user.id,createdAt:{'>':last_seen_noti_time}}).sort('createdAt DESC').limit(100);
		locals.notifications.seen = await Notification.find({user:req.user.id,createdAt:{'<':last_seen_noti_time}}).sort('createdAt DESC').limit(100);

		// new seen count will be sum of what is shown on the screen
		req.user.details.notifications.seen_count=locals.notifications.unseen.length+locals.notifications.seen.length;
		// new unseen count =0
		req.user.details.notifications.unseen_count=0;
		req.user.details.notifications.last_seen_noti_time=new Date().toISOString();
		// updating user details here
		await User.update({id:req.user.id},{details:req.user.details});

		// updating time ago for seen notifications
		locals.notifications.seen.forEach(function(n){
			n.createdAtAgo=GeneralService.timeAgo(n.createdAt);
		});
		// updating time ago for unseen notifications
		locals.notifications.unseen.forEach(function(n){
			n.createdAtAgo=GeneralService.timeAgo(n.createdAt);
		});

		return res.view('list_notifications', locals);
	},
	listLoans:function(req,res){
		var locals={};
		var filters = {
			org:req.org.id
		}
		//filter for type
		if(req.query.type)
			filters.type = req.query.type;
		
		// filter based in id
		if(req.query.ids){
			filters.id = {in: _.map(req.query.ids.split(','), function (each) {
				if(parseInt(each))
					return parseInt(each);
			})}
		}

		Loan.find(filters).sort('date DESC').exec(function(err,loans){
			if(err)
				throw err;
			locals.loans=loans;
			res.view('list_loans',locals);
		})
	},
	viewLoan:function(req,res){
		var locals={};
		res.view('view_loan',locals);
	},
	createLoan:function(req,res){
		if (req.body) { // post request
			console.log(req.body);
			const fx = require('money');
			fx.base = 'INR';
			fx.rates = sails.config.fx_rates;
			var loan = {
				original_currency: req.body.original_currency,
				date: new Date(req.body.date + ' ' + req.body.time + req.body.tz),
				createdBy: 'user',
				description: req.body.description,
				third_party: req.body.third_party,
				type:req.body.type,
				org:req.org.id,
			}
			if (req.body.type == 'lending') {
				loan.original_amount = -(req.body.original_amount);
				loan.amount_inr = -(fx.convert(req.body.original_amount, { from: loan.original_currency, to: "INR" }));
				loan.balance_due_inr = -(fx.convert(req.body.balance_due, { from: loan.original_currency, to: "INR" }));
			} else if (req.body.type == 'borrowing') {
				loan.original_amount = (req.body.original_amount);
				loan.amount_inr = (fx.convert(req.body.original_amount, { from: loan.original_currency, to: "INR" }));
				loan.balance_due_inr = (fx.convert(req.body.balance_due, { from: loan.original_currency, to: "INR" }));
			}
			// console.log('before transaction find or create');
			console.log(loan);
			Loan.create(loan).exec(function (err) {
				if (err)
					throw err;
				else {
					res.redirect('/org/' + req.org.id +'/loans');
				}	
			});
		} else { // view the form
			var locals = {
				loan: {
					date: '',
				},
			};
			res.view('create_loan', locals);
		}
	},
	editLoan:function(req,res){
		if (req.body) { // post request
			console.log(req.body);
			const fx = require('money');
			fx.base = 'INR';
			fx.rates = sails.config.fx_rates;
			var loan = {
				original_currency: req.body.original_currency,
				date: new Date(req.body.date + ' ' + req.body.time + req.body.tz),
				createdBy: 'user',
				description: req.body.description,
				third_party: req.body.third_party,
				type: req.body.type,
				org: req.org.id,
			}
				loan.original_amount = (req.body.original_amount);
				loan.amount_inr = (fx.convert(req.body.original_amount, { from: loan.original_currency, to: "INR" }));
				loan.balance_due_inr = (fx.convert(req.body.balance_due, { from: loan.original_currency, to: "INR" }));
			console.log(loan);
			Loan.update({id:req.params.i_id},loan).exec(function (err, loan) {
				if (err)
					throw err;
				else {
					res.redirect('/org/' + req.org.id + '/loans');
				}
			});
		} else { // view the form
			Loan.findOne({id:req.params.i_id}).exec(function(err,loan){
				loan.sub_total = (fx.convert(loan.sub_total_inr, { to: loan.original_currency, from: "INR" }));
				loan.gst_total = (fx.convert(loan.gst_total_inr, { to: loan.original_currency, from: "INR" }));
				loan.balance_due = (fx.convert(loan.balance_due_inr, { to: loan.original_currency, from: "INR" }));
				if(err)
					throw err;
				var locals = {
					loan: loan,
				};
				res.view('create_loan', locals);
			})
			
		}
	},
	listAssets:function(req,res){
		var locals={};
		var filters = {
			org:req.org.id
		}
		//filter for type
		if(req.query.type)
			filters.type = req.query.type;
		
		// filter based in id
		if(req.query.ids){
			filters.id = {in: _.map(req.query.ids.split(','), function (each) {
				if(parseInt(each))
					return parseInt(each);
			})}
		}

		Asset.find(filters).sort('date DESC').exec(function(err,assets){
			if(err)
				throw err;
			locals.assets=assets;
			res.view('list_assets',locals);
		})
	},
	viewAsset:function(req,res){
		var locals={};
		res.view('view_loan',locals);
	},
	createAsset:function(req,res){
		if (req.body) { // post request
			console.log(req.body);
			const fx = require('money');
			fx.base = 'INR';
			fx.rates = sails.config.fx_rates;
			var asset = {
				original_currency: req.body.original_currency,
				date: new Date(req.body.date + ' ' + req.body.time + req.body.tz),
				createdBy: 'user',
				description: req.body.description,
				name: req.body.name,
				type:req.body.type,
				org:req.org.id,
				unit_original_amount :(req.body.unit_original_amount),
				unit_amount_inr : (fx.convert(req.body.unit_original_amount, { from: req.body.original_currency, to: "INR" })),
				units:req.body.units,
			}
			// console.log('before transaction find or create');
			console.log(asset);
			Asset.create(asset).exec(function (err) {
				if (err)
					throw err;
				else {
					res.redirect('/org/' + req.org.id +'/assets');
				}	
			});
		} else { // view the form
			var locals = {
				asset: {
					date: '',
				},
			};
			res.view('create_asset', locals);
		}
	},
	editAsset:function(req,res){
		if (req.body) { // post request
			console.log(req.body);
			const fx = require('money');
			fx.base = 'INR';
			fx.rates = sails.config.fx_rates;
			var asset = {
				original_currency: req.body.original_currency,
				date: new Date(req.body.date + ' ' + req.body.time + req.body.tz),
				createdBy: 'user',
				description: req.body.description,
				name: req.body.name,
				type:req.body.type,
				org:req.org.id,
				unit_original_amount :(req.body.unit_original_amount),
				unit_amount_inr : (fx.convert(req.body.unit_original_amount, { from: req.body.original_currency, to: "INR" })),
				units:req.body.units,
			}
			// console.log('before transaction find or create');
			console.log(asset);
			Asset.update({id:req.params.i_id},asset).exec(function (err, asset) {
				if (err)
					throw err;
				else {
					res.redirect('/org/' + req.org.id + '/assets');
				}
			});
		} else { // view the form
			Asset.findOne({id:req.params.i_id}).exec(function(err,asset){
				asset.sub_total = (fx.convert(asset.sub_total_inr, { to: asset.original_currency, from: "INR" }));
				asset.gst_total = (fx.convert(asset.gst_total_inr, { to: asset.original_currency, from: "INR" }));
				asset.balance_due = (fx.convert(asset.balance_due_inr, { to: asset.original_currency, from: "INR" }));
				if(err)
					throw err;
				var locals = {
					asset: asset,
				};
				res.view('create_asset', locals);
			})
			
		}
	},
	createDocument: async function(req, res){
		var uploaded = await sails.uploadOne(req.file('attachment'));
		var document = await Document.create({ filename: uploaded.filename, 
			fd: uploaded.fd, mime: uploaded.type, 
			org: req.org.id, transaction: _.get(req, 'body.t', null), description: _.get(req, 'body.description', null) }).fetch();
		if(req.query.redirect == 'true')
			return res.redirect(req.headers.referer);
		res.json(document);
	},
	deleteDocument: async function(req, res){
	},
	listDocuments: async function(req, res){
		var archiver = require('archiver');
		var archive = archiver('zip');

		//filter object, defaults to org id.
		var filter = {
			org: req.org.id
		}
		
		if(req.query.ids){
			var ids = req.query.ids.split(',')
			filter.id = _.filter(ids, function(id){
				if(_.isNumber(parseInt(id)))
					return id;
			});
		}
		// get filtered documents
		var documents = await Document.find(filter);

		if(req.query.download == 'true'){
			//set the filename
			res.attachment(moment().format('LLL') + ' cashflowy documents.zip');
			var s3 = new AWS.S3({
				accessKeyId: sails.config.aws.key,
				secretAccessKey: sails.config.aws.secret,
				region: sails.config.aws.region
			});
			s3Zip
			.archive({ s3:s3, bucket: sails.config.aws.bucket}, '',
				_.map(documents, function(d){return d.fd;}))
			.pipe(res);
		}else{
			res.json(documents);
		}	
	},
	viewDocument: async function(req, res){
		var file = await Document.findOne({ id: req.params.id, org: req.org.id });
		if (!file) res.status(404).view('404');
		if(req.query.download == 'true'){
			res.attachment(file.fileName);
			var downloading = await sails.startDownload(file.fd);
			return downloading.pipe(res);
		}else{
			res.json(file);
		}
		
	},
	bulkOps:function(req,res){
		var locals={}
		res.view('bulk_ops',locals);
	},
	bulkOpsEditCategory:function(req,res){
		var locals={};
		if(!req.body){
			async.auto({
				getCategories:function(callback){
					Category.find({org:req.org.id}).sort('name ASC').exec(callback);
				},
			},function(err,results){
				locals.categories=GeneralService.orderCategories(results.getCategories);
				res.view('bulk_ops_edit_category',locals);
			})
		}else{
			var t_ids=req.body.t_ids.split(',');
			var category = req.body.category;
			// console.log(t_ids);
			// console.log(category);
			async.auto({
				getTransactions: function(cb){
					Transaction.find(t_ids).populate('account').exec(cb)
				},
				updateTransactions: ['getTransactions', function(results, cb){
					// to make sure that only the tlis in the org are updated. 
					// This is so that people dont mess around with the url.
					var relevant_ts=[];
					results.getTransactions.forEach(function(tc){
						if(_.get(tc, 'account.org') == req.org.id)
							relevant_ts.push(tc.id);
					});
					Transaction.update({id: relevant_ts}, {category:category}).exec(cb);
				}]
			}, function(err, results){
				if(err){
					switch (err.message) {
						case 'INVALID_ACCESS':
							return res.status(401).json({error: 'INVALID_ACCESS'});
							break;
						default:
							return res.status(500).json({error: err.message});
							break;
					}
				}
				var filter= JSON.parse(req.query.filter);
				res.redirect('/org/' + req.org.id +'/transactions?'+require('query-string').stringify(filter));
			})
			// res.send('Bulk operation successful, return to list_trasactions');
		}
	},
	listStatementsUploadStatus:function(req,res){
		console.log('req.query:');
		console.log(req.query);
		console.log(req.org)
		if(req.query&&req.query.statements){
			var statement_ids=req.query.statements.split(',')
			Statement.find({id:{in:statement_ids},org:req.org.id}).exec(function(err,statements){
				var locals={statements:statements};
				res.view('list_statement_statuses',locals)
			})
		}
	},
	// this is only used for updating category of a transaction.
	updateTransaction: function(req,res){
		async.auto({
			getTransaction: function(cb){
				Transaction.findOne(req.params.id).populate('account').exec(cb)
			},
			updateTransaction: ['getTransaction', function(results, cb){
				if(_.get(results, 'getTransaction.account.org') != req.org.id)
					return cb(new Error('INVALID_ACCESS'));

				Transaction.update({id: req.params.id}, {category:req.body.category}).exec(cb);
			}],
			getCategory:['updateTransaction',function(results,cb){
				Category.findOne({id:req.body.category}).exec(cb);
			}],
			createActivity:['getCategory',function(results,cb){
				var transaction = results.getTransaction;
				var activity={
					log: {
						t_prev:transaction,
						category_updated:results.getCategory,
					},
					user: req.user.id,
					type: 'transaction__edit_category',
					org: req.org.id,
					doer_type:'user'
				};
				Activity.create(activity).exec(cb);
			}]
		}, function(err, results){
			if(err){
				switch (err.message) {
					case 'INVALID_ACCESS':
						return res.status(401).json({error: 'INVALID_ACCESS'});
						break;
					default:
						return res.status(500).json({error: err.message});
						break;
				}
			}
			var updated = _.get(results, 'updateTransaction[0]', {})
			return res.status(200).json(updated)
		})
	},
	editTransaction:function(req,res){
		Account.find({org:req.org.id}).exec(function(err,accounts){
			if(req.body){ // post request
				console.log(req.body);
				const fx = require('money');
				fx.base='INR';
				fx.rates=sails.config.fx_rates;
				var t={
					original_currency:req.body.original_currency,
					// original_amount:-(req.body.original_amount),
					// amount_inr:-(fx.convert(req.body.original_amount, {from: req.body.original_currency, to: "INR"})),
					occuredAt: new Date(req.body.date+' '+req.body.time+req.body.tz),
					createdBy:'user',
					// type:'income_expense',
					description:req.body.description,
					account:req.body.account_id,
					third_party:req.body.third_party
				}
				if(req.body.type=='expense'){
					t.type='income_expense';
					t.original_amount=-(req.body.original_amount);
					t.amount_inr=-(fx.convert(req.body.original_amount, {from: req.body.original_currency, to: "INR"}));
				}else if(req.body.type=='income'){
					t.type='income_expense';
					t.original_amount=(req.body.original_amount);
					t.amount_inr=(fx.convert(req.body.original_amount, {from: req.body.original_currency, to: "INR"}));
				}else if(req.body.type=='transfer'){
					t.type='transfer';
					t.original_amount=-(req.body.original_amount);
					t.amount_inr=-(fx.convert(req.body.original_amount, {from: req.body.original_currency, to: "INR"}));
					t.to_account=req.body.to_account;
				}
				// console.log('before transaction find or create');
				console.log(t);
				Transaction.update({id:req.params.id},t).exec(function(err,transaction){
					if(err)
						throw err;
					else
						res.redirect('/org/' + req.org.id +'/transactions');
				});
			}else{ // view the form
				Transaction.findOne({id:req.params.id}).exec(function(err,t){
					var locals={
						status:'',
						message:'',
						occuredAt:new Date(t.occuredAt).toISOString(),
						description:t.description,
						original_amount:t.original_amount,
						original_currency:t.original_currency,
						third_party:t.third_party,
						account_id:t.account,
						to_account:t.to_account,
						accounts:accounts,
						// type:'expense',
						// color:'red',
					}
					if(t.type=='transfer')
						locals.type='transfer';
					else if(t.type=='income_expense'){
						if(t.original_amount<0)
							locals.type='expense';
						else
							locals.type='income';
					}
					console.log(locals);
					res.view('create_transaction',locals);
				});
			}
		})
	},
	viewTransactionGroup: function(req, res){
		async.auto({
			getTransactionGroup: function(cb){
				Transaction_group.findOne(req.params.id).exec(cb)
			},
			getTransactionEvents: function(cb){
				Transaction_event.find({transaction_group: req.params.id}).populate('account').populate('to_account').exec(cb);
			},
			getTransactions: function(cb){
				Transaction.find({transaction_group: req.params.id}).populate('account').populate('to_account').populate('tags').populate('category').exec(cb);
			}
		}, function(err, results){
			var locals = {
				transactions: results.getTransactions,
				transaction_events: results.getTransactionEvents
			}
			res.view('view_transaction_group', locals)
		})
	},
	listActivities:function(req,res){
		Activity.find({org:req.org.id})
			.sort('createdAt DESC')
			.populate('user')
			.exec(function(err,activities){
			var locals={
				activities:activities
			}
			res.view('list_activities',locals);
		});
	},
}