'use strict';
const assert = require('node:assert/strict');
const redirect = require('./canonical-https');
for (const [hostname, protocol, expected] of [['myhai.org','http',true],['myhai.org','https',false],['localhost','http',false],['attacker.example','http',false],['myhai.org',undefined,false]]) {
  let didRedirect=false,continued=false;
  redirect({hostname,originalUrl:'/jobs/?query=engineer',get:()=>protocol},{redirect(status,url){didRedirect=true;assert.equal(status,308);assert.equal(url,'https://myhai.org/jobs/?query=engineer');}},()=>{continued=true;});
  assert.equal(didRedirect,expected);assert.equal(continued,!expected);
}
console.log('5 HTTPS redirect checks passed');
