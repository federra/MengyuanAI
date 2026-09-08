import {shell,mount} from './components.js';
import {C,save} from './studio-ui.js';
import {creationPage,bindCreation} from './studio-creation.js';
import {scriptPage,bindScript} from './studio-script.js';
import {boardPage,bindBoard} from './studio-board.js';
import {finishPage,bindFinish} from './studio-finishing.js';
import {settingsMarkup,bindSettings} from './workflow-settings.js';
const page=document.body.dataset.page||'creation';
if(C.s.chain.status==='running'){C.s.chain.status='paused';C.s.chain.runId=null;C.s.chain.message='页面已恢复，可从未完成镜头继续。';save();}
const pages={creation:[creationPage,bindCreation],script:[scriptPage,bindScript],storyboard:[boardPage,bindBoard],finishing:[finishPage,bindFinish]};
function render(){if(document.querySelector('dialog[open]')){C.pendingRender=true;return}C.pendingRender=false;mount(shell({active:page,content:pages[page][0]()+settingsMarkup()+'<dialog class="dialog studio-dialog" id="studio-dialog" aria-labelledby="studio-dialog-title"></dialog>'}));document.querySelector('.app-shell').classList.add('workflow','studio');C.settings=bindSettings(C.s,save,render);document.querySelector('#global-config').onclick=()=>C.settings('prompts',page==='creation'?'novel':page==='script'?'script':page==='storyboard'?'review':'voice');document.querySelector('#studio-dialog').addEventListener('close',()=>{if(C.pendingRender)queueMicrotask(render)});pages[page][1]();}
C.render=render;render();
