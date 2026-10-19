// Start the frontend separately. No .env, API, database, or provider configuration is read.
import {chromium} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const base=process.env.LANDING_PREVIEW_URL??'http://127.0.0.1:5180';
assert.ok(['localhost','127.0.0.1'].includes(new URL(base).hostname),'Use a local preview only.');
await mkdir('.runtime/landing',{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base,{waitUntil:'networkidle'});
 await page.screenshot({path:'.runtime/landing/desktop.png',fullPage:true});
 for(const name of ['Public Queue Page','Staff Queue Controls','Business Dashboard']){
  await page.getByRole('tab',{name,exact:true}).click();
  assert.equal(await page.getByRole('tab',{name,exact:true}).getAttribute('aria-selected'),'true');
 }
 await page.getByRole('tab',{name:'Business Dashboard',exact:true}).focus();await page.keyboard.press('ArrowRight');
 assert.equal(await page.getByRole('tab',{name:'Public Queue Page',exact:true}).getAttribute('aria-selected'),'true');
 await page.locator('summary').filter({hasText:'Apakah pelanggan perlu membuat akun?'}).click();
 assert.equal(await page.locator('details[open]').count(),1);
 assert.deepEqual(await page.locator('a[href^="#"]').evaluateAll(links=>links.filter(a=>!document.getElementById(a.hash.slice(1))).map(a=>a.hash)),[]);
 assert.ok(await page.locator('a[href="/app"]').count()>=3);
 assert.equal(await page.locator('img').evaluateAll(images=>images.filter(i=>!i.complete||i.naturalWidth===0).length),0);
 await page.setViewportSize({width:390,height:844});await page.goto(base,{waitUntil:'networkidle'});
 await page.getByRole('button',{name:'Buka menu'}).click();
 await page.getByRole('navigation',{name:'Navigasi mobile'}).getByRole('link',{name:'Pricing',exact:true}).click();
 assert.equal(await page.locator('#landing-menu').count(),0);
 await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'.runtime/landing/mobile.png',fullPage:true});
 for(const width of [390,320,768]){
  await page.setViewportSize({width,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`Overflow at ${width}`);
 }
 assert.deepEqual(errors,[]);
 console.log('Landing verified: desktop/mobile, keyboard tabs, FAQ, menu, anchors, dashboard links, image loading, no overflow or runtime errors.');
}finally{await browser.close();}
