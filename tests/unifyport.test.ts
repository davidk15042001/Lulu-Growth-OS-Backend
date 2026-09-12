import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, describe, it, mock } from 'node:test';

process.env.NODE_ENV='test';
process.env.JWT_SECRET='unifyport-tests-secret-0123456789';
process.env.UNIFYPORT_API_KEY='dk_live_test';
process.env.UNIFYPORT_WEBHOOK_SIGNING_SECRET='unifyport-webhook-test-secret-0123456789';

const client=await import('../src/modules/provider-control/unifyport.client.js');

after(()=>mock.restoreAll());

describe('UnifyPort client security and compatibility',()=>{
  it('verifies the documented timestamp-dot-body HMAC contract',()=>{
    const timestamp=new Date().toISOString();
    const body=JSON.stringify({id:'evt-1',type:'message.received'});
    const signature=crypto.createHmac('sha256','unifyport-webhook-test-secret-0123456789').update(`${timestamp}.${body}`).digest('hex');
    assert.equal(client.verifyWebhookSignature(body,{timestamp,signature}).verified,true);
    assert.throws(()=>client.verifyWebhookSignature(body,{timestamp,signature:`${signature.slice(0,-1)}0`}),{code:'UNIFYPORT_WEBHOOK_SIGNATURE_INVALID'});
  });

  it('normalizes the provider regions envelope returned by the live API',async()=>{
    mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({data:{provider:'whatsapp',regions:[{code:'de'}]}}),{status:200,headers:{'content-type':'application/json'}}));
    assert.deepEqual(await client.listProviderRegions('whatsapp'),[{code:'de'}]);
  });
});
