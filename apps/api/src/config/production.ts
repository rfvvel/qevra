import {databaseOptions} from './database.js';
export interface StartupConfiguration {NODE_ENV:string;WEB_ORIGIN:string;SUPABASE_URL?:string;SUPABASE_PUBLISHABLE_KEY?:string;DATABASE_URL?:string;DATABASE_CA_CERT?:string;}
export function assertProductionReady(config:StartupConfiguration):void{
 if(config.NODE_ENV!=='production')return;
 if(!config.SUPABASE_URL||!config.SUPABASE_PUBLISHABLE_KEY||!config.DATABASE_URL)throw new Error('Production requires Supabase and database configuration.');
 let web:URL,supabase:URL,database:URL;
 try{web=new URL(config.WEB_ORIGIN);supabase=new URL(config.SUPABASE_URL);database=new URL(config.DATABASE_URL);}catch{throw new Error('Invalid production URL configuration.');}
 if(web.protocol!=='https:'||web.origin!==config.WEB_ORIGIN||web.username||web.password)throw new Error('Production WEB_ORIGIN must be an exact HTTPS origin.');
 if(supabase.protocol!=='https:'||supabase.pathname!=='/'||supabase.search||supabase.hash)throw new Error('SUPABASE_URL must be an HTTPS project origin.');
 if(!['postgres:','postgresql:'].includes(database.protocol)||database.searchParams.get('sslmode')!=='verify-full')throw new Error('Production DATABASE_URL must use sslmode=verify-full.');
 databaseOptions(config);
}
