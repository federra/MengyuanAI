import assert from 'node:assert/strict';
const db=new Map();globalThis.localStorage={getItem:k=>db.get(k)||null,setItem:(k,v)=>db.set(k,v)};
globalThis.document={documentElement:{dataset:{}}};globalThis.window={addEventListener(){}};
const w=await import('../../prototypes/shared/workflow-store.js');
const {C}=await import('../../prototypes/shared/studio-ui.js');
const {prepareWorkbenches,dialogueText,generateSpeech}=await import('../../prototypes/shared/studio-director.js');
let s=w.initial();assert.equal(s.aspect,null);assert.equal(w.generationReady(s),false);
s.topics=[w.makeTopic(s,0),w.makeTopic(s,1),w.makeTopic(s,2)];const original='第一段。\n\n  第二段与角色的完整对白。\n最后的额外动作。';
const t=w.importStoryText(s,'已写好的故事.TXT',original);assert.equal(s.topics.length,1);assert.equal(s.topicArchive.length,3);assert.equal(t.text,original);assert.equal(s.originalImport.text,original);assert.equal(t.title,'已写好的故事');assert.throws(()=>w.importStoryText(s,'bad.txt','   '));assert.equal(s.topics[0].text,original);
w.selectNovel(s,t);w.buildScript(s);w.reviewScript(s);w.buildScript(s,true);w.reviewScript(s);assert.equal(w.scriptReady(s),true);assert.equal(s.aspect,null);w.confirmScript(s);
s.shots=w.makeShots(s);C.s=s;prepareWorkbenches();s.shots[0].dialogues.push({id:'line-second',speaker:'对方',emotion:'克制',text:'请进。',voice:'温暖女声'});s.shots[0].dialogue=dialogueText(s.shots[0]);s.boardVersion=1;s.boardScriptId=s.final.id;
w.boardReview(s);assert.equal(s.report.schemaVersion,2);assert.equal(w.validateReport(s.report,s),true);
for(const mutate of [r=>r.baseBoardVersion++,r=>r.proposedShots[0].dialogues.pop(),r=>r.proposedShots[0].dialogues[1].id=r.proposedShots[0].dialogues[0].id,r=>r.proposedShots[0].dialogues[1].id='unknown',r=>r.proposedShots[0].dialogue='不一致',r=>r.proposedShots[0].prompt+=' @[unknown]']){const r=w.clone(s.report);mutate(r);assert.throws(()=>w.validateReport(r,s));}
const frozen=w.clone(s.shots[0].dialogues);w.applyReport(s);assert.deepEqual(s.shots[0].dialogues,frozen);w.boardReview(s);assert.equal(s.report.issues.length,0);s.boardConfirmed=s.boardVersion;s.shots.forEach(sh=>sh.assets.forEach(a=>{a.image='demo';a.confirmed=true}));assert.equal(w.generationReady(s),false);s.aspect='16:9';s.generation={aspect:'16:9',resolution:'4K',model:'selected-model'};assert.equal(w.generationReady(s),true);assert.equal(w.taskSnapshot(s,'video').model.name,'selected-model');assert.equal(w.taskSnapshot(s,'video').resolution,'4K');
await generateSpeech(s.shots[0]);assert.equal(s.shots[0].audio.segments.length,2);assert.equal(s.jobs[0].input.lineId,'line-second');assert.equal(s.jobs[0].input.voice,'温暖女声');const task=w.clone(s.jobs[0]);s.shots[0].dialogues[1].text='新台词';assert.deepEqual(s.jobs[0],task);
const pending=generateSpeech(s.shots[0]);s.shots[0].dialogues[0].voice='另一音色';await pending;assert.equal(s.shots[0].audio.stale,true);
assert.throws(()=>w.makeVideoSnapshot(s,s.shots[1],'sequential',s.shots[0]));s.shots[0].video={id:'video-first',lastFrame:{id:'frame-first'}};assert.equal(w.makeVideoSnapshot(s,s.shots[1],'sequential',s.shots[0]).previousVideoId,'video-first');
const h=w.hub(),a=h.projects[0].workflow,b=w.initial();h.projects.push({id:b.projectId,name:'B',workflow:b});h.activeId=b.projectId;w.putHub(h);a.idea='异步项目A结果';w.write(a);assert.equal(w.hub().activeId,b.projectId);assert.equal(w.hub().projects[0].workflow.idea,'异步项目A结果');
console.log('PASS: unset aspect; TXT one-card/full text/archive/invalid input; script QC before aspect; multi-line QC IDs/schema/atomic repair; video model snapshot; per-line TTS and stale voice; sequential dependencies; project isolation.');
