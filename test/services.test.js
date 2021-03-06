/**
 * Tests for TagsListService
 */
// var assert = require('assert');
var expect = require('expect');
// var CashflowyService=require('../api/services/CashflowyService.js');
// console.log(CashflowyService);
var Mocha = require('mocha');
var describe = Mocha.describe
var it = Mocha.it
var path  = require('path');
var config=require(path.join(__dirname, '/config/services/CashflowyService.test.js')); 
// console.log('came here');
// console.log(config);


describe('CashflowyService',function(){
	Object.keys(config).forEach(function(function_name){
		describe('#'+function_name, function() {
			var testcases = config[function_name].tests;
			if(config[function_name].return_or_callback=='return'){
				testcases.forEach(function(testcase){
					it(testcase.description,function(done){
						// var output=CashflowyService[function_name](testcase.input);
						if(config[function_name].internal)
							var output=CashflowyService.internal[function_name](testcase.input);
						else
							var output=CashflowyService[function_name](testcase.input);
						expect(output).toEqual(testcase.output);
						done();
					});
				});
			}else if(config[function_name].return_or_callback=='callback'){
				testcases.forEach(function(testcase){
					it(testcase.description,function(done){
						// var output=CashflowyService[function_name](testcase.input);
						if(config[function_name].internal){	
							CashflowyService.internal[function_name](testcase.input,function(err,output){
								expect(output).toEqual(testcase.output);
								done();		
							});
						}
						else{
							CashflowyService[function_name](testcase.input,function(err,output){
								expect(output).toEqual(testcase.output);
								done();		
							});
						}
						
					});
				});
			}
		});
	});
});

// describe('TagsListService', function() {
// 	describe('#UpdateObjWithFiltered', function() {
// 		it('number of objects in input and output should be same', function (done) {
// 			var a = {name:'alex'};
// 			expect(a).toEqual({name:'alex'});
// 			done();
// 		});
// 		it('for input [obj_1,obj_2,obj_3] and [2,3] 2 objects should have filtered=true', function (done) {
// 			var a = {name:'alex'};
// 			expect(a).toEqual({name:'alex1'});
// 			done();
// 		});
// 		it('for input [obj_1,obj_2,obj_3] and [3,4] 1 objects should have filtered=true', function (done) {
// 			done();
// 		});
// 	});
// });