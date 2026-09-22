import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import assert from 'node:assert/strict';
const base = process.argv[2] || 'http://127.0.0.1:4318';
const browser = await chromium.launch();
const ctx = await browser.newContext({viewport:{width:390,height:844}});
const page = await ctx.newPage();
const errors=[]; page.on('pageerror', e=>errors.push(e.message));
const done = async () => { await page.locator('[data-result]:not([hidden])').waitFor({timeout:30000}); await page.waitForFunction(()=>!document.querySelector('[data-dropzone-input]').disabled); };
async function upload(files) {await page.waitForFunction(()=>!document.querySelector('[data-dropzone-input]').disabled); await page.locator('[data-dropzone-input]').setInputFiles(files);}
async function imageInfo() { return page.evaluate(async()=>{
 const blob=await (await fetch(document.querySelector('[data-download]').href)).blob();
 const image=await createImageBitmap(blob); const c=document.createElement('canvas');c.width=image.width;c.height=image.height;
 const x=c.getContext('2d');x.drawImage(image,0,0);const alpha=x.getImageData(0,0,1,1).data[3];image.close();
 return {width:c.width,height:c.height,type:blob.type,alpha};
}); }
try {
 await page.goto(base+'/');
 const fixture = await page.evaluate(()=>{ const c=document.createElement('canvas');c.width=80;c.height=60; const x=c.getContext('2d'); x.fillStyle='#487ca0'; x.fillRect(10,10,60,40);return c.toDataURL('image/png').split(',')[1]; });
 const file={name:'transparent.png',mimeType:'image/png',buffer:Buffer.from(fixture,'base64')};
 for (const locale of ['', '/ar']) {
  await page.goto(base+locale+'/tools/enhance-photo/');
  await upload([file]); await done();
  for (const scale of [2,4]) {
   await page.locator('[data-upscale]').selectOption(String(scale),{force:true});
   await page.waitForFunction(w=>document.querySelector('[data-result-dimensions]').textContent.startsWith(w+'×'),80*scale);
   await done(); const info=await imageInfo();assert.equal(info.width,80*scale);assert.equal(info.height,60*scale);assert.equal(info.alpha,0);assert.equal(info.type,'image/png');
  }
  for(const mime of ['image/jpeg','image/webp']) {
   await page.locator('[data-enhance-format]').selectOption(mime);
   await page.waitForTimeout(350);await done();const info=await imageInfo();assert.equal(info.type,mime);assert.equal(info.alpha,mime==='image/jpeg'?255:0);
  }
  await page.locator('.detail-preview summary').click();
  assert.ok(await page.locator('[data-detail-after]').isVisible());
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:'screenshots/phase2-enhance'+(locale?'-ar':'')+'.png',fullPage:true});
  await page.goto(base+locale+'/tools/image-to-pdf/');
  await upload(Array.from({length:12},(_,i)=>({...file,name:`photo-${i+1}.png`})));
  for (const perPage of [1,2,4,6,9]) {
   await page.locator('[data-per-page]').selectOption(String(perPage),{force:true});
   await page.locator('[data-pdf-paper] img').first().waitFor();
   assert.equal(await page.locator('[data-pdf-paper] img').count(),perPage);
   await page.locator('[data-build-pdf]').click(); await done();
   assert.equal(await page.locator('[data-result-pages]').textContent(),String(Math.ceil(12/perPage)));
   const bytes=await page.evaluate(async()=>Array.from(new Uint8Array(await (await fetch(document.querySelector('[data-download]').href)).arrayBuffer())));
   assert.equal((await PDFDocument.load(new Uint8Array(bytes))).getPageCount(),Math.ceil(12/perPage));
  }
  await page.locator('[data-orientation]').selectOption('landscape');
  await page.locator('[data-pdf-gap]').fill('10'); await page.locator('[data-pdf-gap]').dispatchEvent('change');
  await page.locator('.order-button-remove').last().click();
  await page.locator('[data-build-pdf]').click();await done();
  assert.equal(await page.locator('[data-result-pages]').textContent(),'2');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:'screenshots/phase2-pdf'+(locale?'-ar':'')+'.png',fullPage:true});
 }
 if(base.endsWith('4318')) {
  const fallback=await page.evaluate(async(encoded)=>{
   const {MAIN}=await import('/assets/js/core/main-engines.js');const file=new File([Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))],'test.png',{type:'image/png'});
   const state={controllers:new Map()};const result=await MAIN.enhance.enhance(state,{jobId:'fallback',file,options:{scale:2,outputMime:'image/png'}});
   const bitmap=await createImageBitmap(result.blob);const c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;const x=c.getContext('2d');x.drawImage(bitmap,0,0);
   const alpha=x.getImageData(0,0,1,1).data[3];bitmap.close();
   const prepared=await MAIN.pdf.encodePage(state,{jobId:'pdf-fallback',file});
   const pdf=await MAIN.pdf.assemble(state,{pages:Array(12).fill(prepared),options:{imagesPerPage:4}});
   return {width:result.meta.width,height:result.meta.height,alpha,pages:pdf.meta.pages};
  },fixture);
  assert.deepEqual(fallback,{width:160,height:120,alpha:0,pages:3});
 }
 assert.deepEqual(errors,[]);console.log('PASS: bilingual mobile upscale 2×/4×, PNG/WebP alpha, JPEG export, zoom, PDF presets 1/2/4/6/9, odd counts, landscape, gaps, remove and main-thread fallback.');
} finally {await browser.close();}
