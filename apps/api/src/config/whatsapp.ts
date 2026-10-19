import {z} from 'zod';

const optional=z.string().trim().min(1).optional();
export function whatsappConfiguration(input:Record<string,unknown>){
  const parsed=z.object({
    WHATSAPP_PROVIDER:z.enum(['DISABLED','MOCK','META','TWILIO']).optional(),
    TWILIO_HOSTED_DEMO_ENABLED:z.enum(['true','false']).default('false'),
    TWILIO_ACCOUNT_SID:z.string().regex(/^AC[0-9a-fA-F]{32}$/).optional(),
    TWILIO_AUTH_TOKEN:optional,
    TWILIO_WHATSAPP_FROM:z.string().regex(/^whatsapp:\+[1-9][0-9]{7,14}$/).optional(),
    TWILIO_WEBHOOK_ORIGIN:z.url().refine(v=>{const u=new URL(v);return u.protocol==='https:'&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash&&v===u.origin;}).optional(),
    META_WHATSAPP_ACCESS_TOKEN:optional,
    META_WHATSAPP_PHONE_NUMBER_ID:z.string().regex(/^\d+$/).optional(),
    META_WHATSAPP_API_VERSION:z.string().regex(/^v\d+\.0$/).optional(),
    META_WHATSAPP_APP_SECRET:optional,
    META_WHATSAPP_WEBHOOK_VERIFY_TOKEN:optional,
    META_WHATSAPP_NEAR_TURN_TEMPLATE:z.string().regex(/^[a-z0-9_]+$/).optional(),
    META_WHATSAPP_YOUR_TURN_TEMPLATE:z.string().regex(/^[a-z0-9_]+$/).optional(),
    META_WHATSAPP_TEMPLATE_LANGUAGE:z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/).optional(),
  }).safeParse(Object.fromEntries(Object.entries(input).map(([k,v])=>[k,v===''?undefined:v])));
  if(!parsed.success)throw new Error('Invalid WhatsApp configuration: '+parsed.error.issues.map(i=>i.path.join('.')).join(', '));
  const c=parsed.data;
  // Compatibility with existing development installations. Explicit selection wins.
  const mode=c.WHATSAPP_PROVIDER??(input.MOCK_WHATSAPP_ENABLED==='true'?'MOCK':'DISABLED');
  if(mode==='TWILIO'){
    if(input.NODE_ENV==='production'&&c.TWILIO_HOSTED_DEMO_ENABLED!=='true')throw new Error('Twilio Sandbox is development/demo only unless TWILIO_HOSTED_DEMO_ENABLED is explicitly enabled.');
    const missing=['TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_WHATSAPP_FROM','TWILIO_WEBHOOK_ORIGIN'].filter(key=>!c[key as keyof typeof c]);
    if(missing.length)throw new Error('Missing WhatsApp configuration: '+missing.join(', '));
  }
  if(mode==='META'){
    const missing=['META_WHATSAPP_ACCESS_TOKEN','META_WHATSAPP_PHONE_NUMBER_ID','META_WHATSAPP_API_VERSION',
      'META_WHATSAPP_APP_SECRET','META_WHATSAPP_WEBHOOK_VERIFY_TOKEN','META_WHATSAPP_NEAR_TURN_TEMPLATE',
      'META_WHATSAPP_YOUR_TURN_TEMPLATE','META_WHATSAPP_TEMPLATE_LANGUAGE'].filter(key=>!c[key as keyof typeof c]);
    if(missing.length)throw new Error('Missing WhatsApp configuration: '+missing.join(', '));
  }
  return {...c,mode:input.NODE_ENV==='production'&&mode==='MOCK'?'DISABLED' as const:mode};
}
export type WhatsAppConfiguration=ReturnType<typeof whatsappConfiguration>;
