import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { asTwilioAddress, computeTwilioSignature, twilioMessageForm } from '../src/modules/provider-control/twilio.client.js';
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
});
