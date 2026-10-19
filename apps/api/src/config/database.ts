import {X509Certificate} from 'node:crypto';
import type {PoolConfig} from 'pg';

export interface DatabaseConfiguration {NODE_ENV:string;DATABASE_URL?:string;DATABASE_CA_CERT?:string;}
// Build explicit TLS options in production; connection-string SSL parameters
// cannot override them, and no machine-specific certificate file is loaded.
export function databaseOptions(config:DatabaseConfiguration):PoolConfig{
 if(!config.DATABASE_URL)throw new Error('Database configuration missing.');
 if(config.NODE_ENV!=='production')return {connectionString:config.DATABASE_URL};
 let url:URL;
 try{url=new URL(config.DATABASE_URL);}catch{throw new Error('Invalid database URL configuration.');}
 if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||url.searchParams.getAll('sslmode').length!==1||url.searchParams.get('sslmode')!=='verify-full')throw new Error('Production DATABASE_URL must use sslmode=verify-full.');
 for(const key of url.searchParams.keys()){
  if(key!=='sslmode'&&(/ssl/i.test(key)||['host','hostaddr','port','uselibpqcompat'].includes(key)))throw new Error('Unsupported production database override. Use DATABASE_CA_CERT for a custom CA.');
 }
 url.searchParams.delete('sslmode');
 let ca:string|undefined;
 if(config.DATABASE_CA_CERT){
  ca=config.DATABASE_CA_CERT.replace(/\\n/g,'\n').trim();
  try{new X509Certificate(ca);}catch{throw new Error('DATABASE_CA_CERT must contain a valid PEM certificate.');}
 }
 return {connectionString:url.toString(),ssl:{rejectUnauthorized:true,...(ca?{ca}:{})}};
}
