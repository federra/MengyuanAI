import { useEffect, useState } from "react";
import { api, unwrap } from "./api";

export function AssetCredentials() {
  const [revision, setRevision] = useState<number | null>(null);
  const [configured, setConfigured] = useState(false);
  const [bucket, setBucket] = useState("mengyuanaibucket");
  const [project, setProject] = useState("mengyuanai");
  const [ak, setAk] = useState("");
  const [sk, setSk] = useState("");
  const [savedConfiguration, setSavedConfiguration] = useState("");
  const [checkResult, setCheckResult] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    api.GET("/api/v1/settings/asset-credentials").then(unwrap).then(s => {
      if (!active) return;
      setRevision(s.revision); setConfigured(s.configured);
      setSavedConfiguration(s.configuration ? JSON.stringify([s.configuration.bucket, s.configuration.project_name]) : "");
      if (s.configuration) { setBucket(s.configuration.bucket); setProject(s.configuration.project_name); }
    }).catch(e => { if (active) setMessage(e.message); });
    return () => { active = false; };
  }, []);
  async function save() {
    if (revision === null || busy) return;
    setBusy(true); setMessage("");
    try {
      const s = unwrap(await api.PUT("/api/v1/settings/asset-credentials", { body: {
        base_version: revision, bucket, region: "cn-beijing", project_name: project,
        access_key: ak, secret_key: sk,
      } }));
      setRevision(s.revision); setConfigured(s.configured); setAk(""); setSk("");
      setSavedConfiguration(JSON.stringify([bucket, project])); setCheckResult("");
      setMessage("已加密保存。尚未验证 TOS 上传权限或素材库访问权限。");
    } catch (e) { setMessage((e as Error).message); }
    finally { setBusy(false); }
  }
  async function refresh() {
    setBusy(true);
    try {
      const s = unwrap(await api.GET("/api/v1/settings/asset-credentials"));
      setRevision(s.revision); setConfigured(s.configured);
      setSavedConfiguration(s.configuration ? JSON.stringify([s.configuration.bucket, s.configuration.project_name]) : "");
      setCheckResult("");
      setMessage("已读取最新版本基准；保留当前输入，请核对后保存。");
    } catch (e) { setMessage((e as Error).message); }
    finally { setBusy(false); }
  }
  async function check() {
    if (!revision || busy) return;
    setBusy(true); setCheckResult("");
    try {
      const s = unwrap(await api.POST("/api/v1/settings/asset-credentials/test", { body: { base_version: revision } }));
      const describe = (v: string) => v === "ok" ? "读取成功" : v === "not_tested" ? "未执行" : `未通过（${v}）`;
      setCheckResult(`TOS：${describe(s.tos)}；素材库：${describe(s.assets)}。仅验证读取权限，未验证上传、入库或视频生成。`);
    } catch(e) { setCheckResult((e as Error).message); }
    finally { setBusy(false); }
  }
  return <details>
    <summary>方舟素材上传与审核配置</summary>
    <p>{configured ? `凭据已加密保存 · v${revision}` : "尚未保存素材凭据"} · {checkResult ? "读取检查结果见下方" : "本页尚未检查连接"}</p>
    <p>独立于视频 API Key。AK/SK 仅发送给本机后端加密保存，不写入浏览器草稿；离开此配置页会清除尚未保存的密钥。</p>
    <fieldset disabled={busy || revision === null}>
      <label>TOS 桶名<input aria-label="TOS 桶名" value={bucket} onChange={e=>setBucket(e.target.value)} /></label>
      <label>TOS 地域<select aria-label="TOS 地域" value="cn-beijing" disabled><option value="cn-beijing">华北2（北京） · cn-beijing</option></select></label>
      <label>火山资源项目名<input aria-label="火山资源项目名" value={project} onChange={e=>setProject(e.target.value)} /></label>
      <label>Access Key（AK）<input aria-label="素材 Access Key" type="password" autoComplete="off" value={ak} onChange={e=>setAk(e.target.value)} /></label>
      <label>Secret Key（SK）<input aria-label="素材 Secret Key" type="password" autoComplete="new-password" value={sk} onChange={e=>setSk(e.target.value)} /></label>
      <button type="button" disabled={!bucket.trim() || !project.trim() || !ak.trim() || !sk.trim()} onClick={save}>{busy ? "正在保存…" : "保存素材配置与 AK/SK"}</button>
    </fieldset>
    <button type="button" disabled={busy} onClick={refresh}>读取最新素材配置基准（保留输入）</button>
    {message && <p role="status">{message}</p>}
    <p>权限检查最多读取一次桶信息、查询一次素材组，失败即停；可能产生少量请求费，不会上传或生成。</p>
    <button type="button" disabled={busy || !configured || !!ak || !!sk || savedConfiguration !== JSON.stringify([bucket, project])} onClick={check}>检查已保存的读取权限（可能产生请求费）</button>
    {checkResult && <p role="status">{checkResult}</p>}
    <p>自动上传、素材入库审核尚待接入，保存或读取成功不代表视频链已通过。</p>
  </details>;
}
