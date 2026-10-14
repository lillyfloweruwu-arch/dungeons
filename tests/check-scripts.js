const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dungeon-scripts-'));
let count=0;
try{
  for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
    if(/\bsrc\s*=/.test(m[1])) continue;
    const file=path.join(dir,`inline-${++count}.js`);
    fs.writeFileSync(file,m[2]);
    execFileSync(process.execPath,['--check',file],{stdio:'inherit'});
  }
  console.log(`PASS: node --check on all ${count} inline scripts`);
}finally{ fs.rmSync(dir,{recursive:true,force:true}); }
