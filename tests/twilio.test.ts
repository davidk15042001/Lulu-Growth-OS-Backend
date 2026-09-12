import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { asTwilioAddress, computeTwilioSignature, createWhatsAppSender, getWhatsAppContentTemplateApproval, listWhatsAppSenders, twilioMessageForm } from '../src/modules/provider-control/twilio.client.js';
import { requiresWhatsAppTemplate } from '../src/modules/omnichannel/omnichannel.service.js';

describe('Twilio transport', () => {
  it('computes the documented HMAC-SHA1 form signature deterministically', () => {
    const signature=computeTwilioSignature('https://example.com/hook',{To:'whatsapp:+222',Body:'hello',From:'whatsapp:+111'},'secret');
    assert.equal(signature,computeTwilioSignature('https://example.com/hook',{From:'whatsapp:+111',To:'whatsapp:+222',Body:'hello'},'secret'));
    assert.notEqual(signature,computeTwilioSignature('https://example.com/hook',{From:'whatsapp:+111',To:'whatsapp:+222',Body:'changed'},'secret'));
  });

  it('normalizes only supported Twilio channel addresses', () => {
    assert.equal(asTwilioAddress('WHATSAPP','+491234'),'whatsapp:+491234');
    assert.equal(asTwilioAddress('FACEBOOK_MESSENGER','page-id'),'messenger:page-id');
    assert.throws(()=>asTwilioAddress('INSTAGRAM','profile-id'));
  });

  it('uses approved content templates without leaking a free-form WhatsApp body',()=>{
    const form=twilioMessageForm({
      from:'whatsapp:+49111',to:'whatsapp:+49222',body:'must not be sent directly',
      contentSid:'HX0123456789abcdef0123456789abcdef',contentVariables:{'1':'Hello from Lulu'},
    });
    assert.equal(form.get('ContentSid'),'HX0123456789abcdef0123456789abcdef');
    assert.equal(form.get('ContentVariables'),'{"1":"Hello from Lulu"}');
    assert.equal(form.has('Body'),false);
  });

  it('requires a template only after the customer service window closes',()=>{
    const now=Date.parse('2026-09-12T12:00:00Z');
    assert.equal(requiresWhatsAppTemplate([{direction:'INBOUND',receivedAt:'2026-09-11T12:00:01Z'}],now),false);
    assert.equal(requiresWhatsAppTemplate([{direction:'INBOUND',receivedAt:'2026-09-11T12:00:00Z'}],now),true);
    assert.equal(requiresWhatsAppTemplate([],now),true);
  });

  it('uses the Twilio v2 Senders contract and accepts v2 sender responses',async()=>{
    const auth={accountSid:'AC00000000000000000000000000000000',username:'AC00000000000000000000000000000000',password:'secret'};
    let requestBodyJson='';
    const fetchMock=mock.method(globalThis,'fetch',async(_url:string|URL|Request,init?:RequestInit)=>{
      requestBodyJson=String(init?.body??'{}');
      return new Response(JSON.stringify({sid:'XE00000000000000000000000000000000',sender_id:'whatsapp:+491701234567',status:'ONLINE',configuration:{waba_id:'123456789'},profile:{name:'Lulu Customer'}}),{status:201,headers:{'content-type':'application/json'}});
    });
    try {
      const sender=await createWhatsAppSender({auth,address:'whatsapp:+491701234567',wabaId:'123456789',displayName:'Lulu Customer'});
      const requestBody=JSON.parse(requestBodyJson) as Record<string,unknown>;
      assert.equal(sender.status,'ONLINE');
      assert.equal(requestBody.sender_id,'whatsapp:+491701234567');
      assert.deepEqual(requestBody.configuration,{waba_id:'123456789'});
      assert.deepEqual(requestBody.profile,{name:'Lulu Customer'});
    } finally { fetchMock.mock.restore(); }
  });

  it('lists the senders registered in a Twilio account without exposing credentials',async()=>{
    const auth={accountSid:'AC00000000000000000000000000000000',username:'AC00000000000000000000000000000000',password:'secret'};
    const fetchMock=mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({senders:[{sid:'XE00000000000000000000000000000000',senderId:'whatsapp:+491701234567',status:'ONLINE',profile:{name:'Lulu'}}]}),{status:200}));
    try {
      const senders=await listWhatsAppSenders(auth);
      assert.deepEqual(senders.map((sender)=>({address:sender.senderId,status:sender.status})),[{address:'whatsapp:+491701234567',status:'ONLINE'}]);
    } finally { fetchMock.mock.restore(); }
  });

  it('checks content ownership and Meta approval in the sender subaccount',async()=>{
    const auth={accountSid:'AC00000000000000000000000000000000',username:'AC00000000000000000000000000000000',password:'secret'};
    const fetchMock=mock.method(globalThis,'fetch',async(url:string|URL|Request)=>{
      const value=String(url);
      return new Response(JSON.stringify(value.endsWith('/ApprovalRequests')
        ? {whatsapp:{status:'approved',rejection_reason:''}}
        : {sid:'HX00000000000000000000000000000000',account_sid:auth.accountSid,friendly_name:'customer_outreach'}),{status:200});
    });
    try {
      const template=await getWhatsAppContentTemplateApproval('HX00000000000000000000000000000000',auth);
      assert.equal(template.accountSid,auth.accountSid);
      assert.equal(template.approvalStatus,'APPROVED');
    } finally { fetchMock.mock.restore(); }
  });
});
