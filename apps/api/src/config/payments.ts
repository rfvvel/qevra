export function mockPaymentEnabled(config:{NODE_ENV:string;PAYMENT_PROVIDER:string;PAYMENT_HOSTED_DEMO_ENABLED?:string}):boolean{
  return config.PAYMENT_PROVIDER==='MOCK' && (config.NODE_ENV!=='production'||config.PAYMENT_HOSTED_DEMO_ENABLED==='true');
}
