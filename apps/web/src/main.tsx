import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, unwrap, type Project, type MediaFile, type Job, type Settings } from './api';
import './style.css';

const modules = ['项目', '创作', '资产', '任务记录', '系统设置'];
const states: Record<string, string> = {queued:'排队中', running:'校验中', succeeded:'已完成', failed:'失败', unknown:'待核实'};
function App() {
  const [module, setModule] = useState('项目');
  const [projects, setProjects] = useState<Project[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Project>();
  const [files, setFiles] = useState<MediaFile[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [settings, setSettings] = useState<Settings>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [editName, setEditName] = useState('');
  const [market, setMarket] = useState<'zh'|'en'>('zh');
  const [typeId, setTypeId] = useState('');
  const [theme, setTheme] = useState(() => {try { return localStorage.getItem('shortfilm.theme') || 'light'; } catch { return 'light'; }});
  useEffect(() => { document.documentElement.dataset.theme = theme; try {localStorage.setItem('shortfilm.theme', theme);} catch {} }, [theme]);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try {await action();} catch(e) {setError(e instanceof Error ? e.message : '服务连接失败，请重试');} finally {setBusy(false);}
  }
  async function refreshProjects(page = offset) {
    const data = unwrap(await api.GET('/api/v1/projects', {params:{query:{offset:page, limit:20}}}));
    setProjects(data.items); setTotal(data.total);
  }
  useEffect(() => {void run(async () => {await refreshProjects(offset); setSettings(unwrap(await api.GET('/api/v1/settings')));});}, [offset]);
  useEffect(() => {
    if (!selected) {setFiles([]); setJobs([]); return;}
    const pid = selected.id;
    let active = true;
    const refresh = async () => {
      try {
        const [f,j] = await Promise.all([api.GET('/api/v1/projects/{pid}/files', {params:{path:{pid}}}),api.GET('/api/v1/projects/{pid}/jobs', {params:{path:{pid}}})]);
        if (active) {setFiles(unwrap(f)); setJobs(unwrap(j));}
      } catch(e) {if(active) setError(e instanceof Error ? e.message : '无法载入项目数据');}
    };
    void refresh(); const timer = setInterval(refresh, 3000);
    return () => {active = false; clearInterval(timer);};
  }, [selected?.id]);
  async function openProject(p: Project) {
    await run(async () => {const fresh = unwrap(await api.GET('/api/v1/projects/{pid}', {params:{path:{pid:p.id}}})); setSelected(fresh); setEditName(fresh.name); setFiles([]); setJobs([]); setModule('创作');});
  }
  return <div className="app">
    <aside><div className="brand"><span>▶</span> AI短片工坊</div><nav aria-label="主导航">{modules.map((m,i) => <button key={m} className={module===m?'active':''} onClick={()=>{setModule(m); setError('');}}><span aria-hidden>{['▦','✎','▧','◷','⚙'][i]}</span>{m}</button>)}</nav><div className="local"><i/> 本地工作空间<small>工程底座 · M0</small></div></aside>
    <div className="workspace"><header><span>{module}{selected && module!=='项目' ? ` / ${selected.name}` : ''}</span><label>UI主题 <select value={theme} onChange={e=>setTheme(e.target.value)}><option value="light">浅色</option><option value="dark">深色</option><option value="sky">晴空蓝</option></select></label></header>
    <main><div className="heading"><div><p className="eyebrow">AI SHORT FILM STUDIO</p><h1>{module==='项目'?'我的项目':module}</h1><p className="muted">{module==='项目'?'从一个想法开始，留存每一次创作。':'项目与文件已持久保存，可在下次打开时继续。'}</p></div>{module==='项目' && <button className="primary" onClick={()=>setCreating(true)}>＋ 新建项目</button>}</div>
    {error && <div role="alert" className="alert">{error} <button onClick={()=>void run(()=>refreshProjects())}>重新连接</button></div>}{notice && <div role="status" className="notice">{notice}</div>}
    {module==='项目' && <>
      <div className="summary"><span>全部项目 <b>{total}</b></span><span className="muted">最近编辑优先 · 正式数据保存于本地服务</span></div>
      {!projects.length ? <section className="empty"><span>▦</span><h2>创建你的第一部短片</h2><p>先为项目命名，再逐步丰富故事与画面。</p><button onClick={()=>setCreating(true)}>新建项目</button></section> : <div className="cards">{projects.map(p=><article key={p.id}><div className="cover"><span>▶</span><small>尚未设置封面</small></div><div className="card-body"><div className="row"><h2>{p.name}</h2><span className="badge">创作中</span></div><p className="muted">{settings?.project_types.find(t=>t.id===p.type_id)?.name || '未分类'} · {p.market==='zh'?'中文市场':'英文市场'} · 创意阶段</p><div className="row"><small>更新于 {new Date(p.updated_at).toLocaleString('zh-CN',{hour12:false})}</small><button disabled={busy} onClick={()=>void openProject(p)}>继续创作 →</button></div></div></article>)}</div>}
      {total>20 && <div className="pagination"><button disabled={!offset} onClick={()=>setOffset(offset-20)}>上一页</button><span>{offset+1}–{Math.min(offset+20,total)} / {total}</span><button disabled={offset+20>=total} onClick={()=>setOffset(offset+20)}>下一页</button></div>}
    </>}
    {module==='创作' && (selected ? <><div className="stages">{['创意','故事','剧本','分镜','导出'].map((s,i)=><span className={i===0?'current':''} key={s}>{i+1}　{s}</span>)}</div><section className="panel"><h2>项目资料</h2><form onSubmit={e=>{e.preventDefault(); void run(async()=>{const p=unwrap(await api.PATCH('/api/v1/projects/{pid}',{params:{path:{pid:selected.id}},body:{name:editName,revision:selected.revision}})); setSelected(p); await refreshProjects(); setNotice('项目已保存');});}}><label>项目名称<input value={editName} onChange={e=>setEditName(e.target.value)} required maxLength={50}/></label><button className="primary" disabled={busy}>保存修改</button><button type="button" disabled={busy} onClick={()=>void run(async()=>{const p=unwrap(await api.GET('/api/v1/projects/{pid}',{params:{path:{pid:selected.id}}}));setSelected(p);setNotice(`已读取版本 ${p.revision}，保留输入框中的草稿，可检查后再保存`);})}>读取最新版本</button></form></section><section className="panel"><h2>创作能力将在 M1 接入</h2><p className="muted">下一阶段将接入一句话生成故事、导演对话、剧本与分镜。当前可以保存项目、上传参考图片并查看文件校验任务。</p><button onClick={()=>setModule('资产')}>管理项目图片 →</button></section></> : <EmptyProject/>)}
    {module==='资产' && (selected ? <section className="panel"><div className="row"><div><h2>项目图片</h2><p className="muted">PNG / JPEG / WebP · 最大 20 MB</p></div><label className="upload">上传图片<input aria-label="上传图片" type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={e=>{const file=e.target.files?.[0];if(!file)return; void run(async()=>{const form=new FormData(); form.append('file',file); const response=await fetch(`/api/v1/projects/${selected.id}/files`,{method:'POST',body:form}); if(!response.ok){const b=await response.json();throw new Error(b.detail);} const saved:MediaFile=await response.json();setFiles(old=>[saved,...old]);setNotice('图片已保存');});e.target.value='';}}/></label></div>{!files.length ? <p className="muted">还没有图片，上传后可进行完整性校验。</p> : <div className="media-grid">{files.map(f=><article key={f.id}><img src={`/api/v1/projects/${selected.id}/files/${f.id}`} alt={f.filename}/><div className="card-body"><h3>{f.filename}</h3><p className="muted">{(f.size/1024).toFixed(1)} KB</p><button disabled={busy} onClick={()=>void run(async()=>{const j=unwrap(await api.POST('/api/v1/projects/{pid}/jobs',{params:{path:{pid:selected.id},header:{'idempotency-key':crypto.randomUUID()}},body:{kind:'file.verify',file_id:f.id}}));setJobs(old=>[j,...old]);setNotice('校验任务已加入队列');})}>校验文件</button></div></article>)}</div>}</section>:<EmptyProject/>)}
    {module==='任务记录' && (selected ? <section className="panel"><h2>项目任务</h2><p className="muted">文件完整性校验 · 自动刷新</p>{jobs.length ? <div className="table-wrap"><table><thead><tr><th>任务</th><th>状态</th><th>创建时间</th><th>追踪 ID</th></tr></thead><tbody>{jobs.map(j=><tr key={j.id}><td>文件校验</td><td><span className="badge">{states[j.state] || j.state}</span>{j.error && <small>{j.error}</small>}</td><td>{new Date(j.created_at).toLocaleString('zh-CN')}</td><td><code>{j.id}</code></td></tr>)}</tbody></table></div>:<p>还没有任务，可在资产中校验已上传图片。</p>}</section>:<EmptyProject/>)}
    {module==='系统设置' && <section className="panel"><h2>当前工作空间</h2><dl><dt>运行模式</dt><dd>本地单用户</dd><dt>项目类型</dt><dd>{settings?.project_types.map(t=>t.name).join('、') || '读取中'}</dd><dt>提示词种子</dt><dd>{settings?.prompt_count ?? '—'} 项契约指令，尚未经真实模型验证</dd><dt>生成服务</dt><dd>将在 M1–M2 配置与接入</dd></dl></section>}
    </main></div>
    {creating && <div className="overlay"><section role="dialog" aria-modal="true" aria-labelledby="dialog-title" className="dialog"><h2 id="dialog-title">新建项目</h2><p className="muted">画幅与生成规格会在首次分镜时确认。</p><form onSubmit={e=>{e.preventDefault(); void run(async()=>{await api.POST('/api/v1/projects',{body:{name,market,type_id:typeId||null}}).then(unwrap);await refreshProjects(0);setOffset(0);setName('');setCreating(false);});}}><label>项目名称<input autoFocus required maxLength={50} value={name} onChange={e=>setName(e.target.value)} placeholder="给这部短片起个名字"/></label><label>类型<select value={typeId} onChange={e=>setTypeId(e.target.value)}><option value="">未分类</option>{settings?.project_types.map(t=><option value={t.id} key={t.id}>{t.name}</option>)}</select></label><label>市场<select value={market} onChange={e=>setMarket(e.target.value as 'zh'|'en')}><option value="zh">中文</option><option value="en">英文</option></select></label>{error && <p role="alert" className="alert">{error}</p>}<div className="actions"><button type="button" disabled={busy} onClick={()=>setCreating(false)}>取消</button><button className="primary" disabled={busy || !name.trim()}>创建项目</button></div></form></section></div>}
  </div>;
}
function EmptyProject(){return <section className="empty"><h2>请先选择一个项目</h2><p>在项目页点击“继续创作”后，可查看该项目的数据。</p></section>;}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
