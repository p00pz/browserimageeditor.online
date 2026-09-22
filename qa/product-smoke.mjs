import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const browser = await chromium.launch();
const base = process.argv[2] || 'http://127.0.0.1:4317';
const errors = [];
const context = await browser.newContext({viewport:{width:1440,height:1000}});
context.on('page', p => p.on('pageerror', e => errors.push(e.message)));
const page = await context.newPage();
try {
 for (const locale of ['', '/ar']) {
  await page.goto(base+locale+'/');
  await page.locator('[data-search-controls]').waitFor({state:'visible'});
  await page.locator('#tool-search').fill('PDF');
  assert.ok(await page.locator('.tool-card:visible').count()>=1);
  await page.locator('#tool-search').fill('xxxxxxxx');
  assert.equal(await page.locator('.tool-card:visible').count(),0);
  await page.locator('[data-search-clear]').click();
  assert.ok(await page.locator('.tool-card:visible').count()>=6);
  for (const width of [390,768,1440]) {
   await page.setViewportSize({width,height:1000});
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth), 'home overflow '+locale+width);
  }
  await page.locator('#tool-search').blur();
  await page.screenshot({path:'screenshots/product-home'+(locale?'-ar':'')+'.png',fullPage:true});
 }
 await page.setViewportSize({width:390,height:844});
 await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});
 await page.goto(base+'/ar/');
 await page.screenshot({path:'screenshots/product-mobile-dark-ar.png',fullPage:true});
 await page.emulateMedia({colorScheme:'light'});
 await page.setViewportSize({width:1440,height:1000});
 await page.goto(base+'/tools/compress-image/');
 await page.locator('[data-sample-image]').click();
 await page.locator('[data-result]:not([hidden])').waitFor({timeout:30000});
 await page.locator('.next-tool select').selectOption('resize-image');
 const opened = context.waitForEvent('page');
 await page.locator('.next-tool button').click();
 const next=await opened;
 await next.waitForLoadState();
 await next.locator('[data-result]:not([hidden])').waitFor({timeout:30000});
 assert.equal(new URL(next.url()).hash,'');
 assert.ok(await next.evaluate(async()=>{const a=document.querySelector('[data-download]');return a?.href.startsWith('blob:') && (await (await fetch(a.href)).blob()).size>0;}));
 await next.screenshot({path:'screenshots/product-handoff.png',fullPage:true});
 await next.close();
 await page.evaluate(()=>{window.open=()=>null;});
 await page.locator('.next-tool button').click();
 assert.match(await page.locator('[data-status][role="status"]').textContent(), /Allow pop-ups/);
 await page.setViewportSize({width:390,height:844});
 for (const tool of ['convert-image','crop-image','image-to-pdf','enhance-photo']) {
  await page.goto(base+'/tools/'+tool+'/');
  await page.locator('[data-dropzone-input]').waitFor();
  await page.waitForFunction(()=>!document.querySelector('[data-dropzone-input]').disabled);
  await page.locator('[data-sample-image]').click();
  if(tool==='crop-image') {
   await page.locator('[data-crop-apply]').click({timeout:10000});
  } else if(tool==='image-to-pdf') {
   await page.locator('[data-build-pdf]').click({timeout:10000});
  }
  await page.locator('[data-result]:not([hidden])').waitFor({timeout:30000});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth), 'tool overflow '+tool);
 }
 await page.setViewportSize({width:390,height:844});
 await page.goto(base+'/');
 await page.locator('[data-mobile-menu-toggle]').click();
 assert.equal(await page.evaluate(()=>document.body.style.overflow),'hidden');
 await page.setViewportSize({width:1024,height:844});
 await page.waitForFunction(()=>document.body.style.overflow==='');
 assert.deepEqual(errors,[]);
 console.log('PASS: bilingual discovery, 3 viewport widths, in-memory handoff, six tools, mobile navigation; no runtime errors.');
} finally {await browser.close();}
