import { useEffect, useRef, useState } from "react";
import { api, unwrap } from "./api";
import type { components } from "./generated/api";

type Status = components["schemas"]["CredentialStatus"];
const labels: Record<string, string> = {
  ok: "连接成功（仅验证此次小请求，尚未完成故事链验收）",
  text_credential_missing: "尚未配置 API 密钥",
  credential_endpoint_mismatch: "服务地址已变化，请重新保存该地址的密钥",
  provider_auth_failed: "认证失败，请检查密钥及账号权限",
  provider_rate_limited: "供应商限流，请稍后重试",
  provider_timeout: "连接超时；供应商可能已计费，请核实后再试",
  provider_connection_failed: "无法连接供应商，请检查服务地址和网络",
  provider_invalid_response: "模型响应不符合 JSON 约定，请检查模型能力",
  provider_acceptance_unknown: "供应商状态不明，可能已计费，请核实后再试",
  provider_rejected: "供应商拒绝请求，请检查模型与服务地址",
  credential_revision_conflict: "密钥已更新，请刷新状态后重试",
};
const routeFields = [
  "provider",
  "model",
  "endpoint",
  "capability",
  "credential_ref",
  "timeout_seconds",
];
const identity = (value: Record<string, unknown> | null) =>
  JSON.stringify(routeFields.map((k) => value?.[k] ?? null));

export function ModelCredentials({
  node,
  revision,
  value,
}: {
  node: string;
  revision: number;
  value: Record<string, unknown> | null;
}) {
  const generation = useRef(0);
  const [secret, setSecret] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  const [saved, setSaved] = useState<Record<string, unknown> | null>(null);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const draftIdentity = identity(value);
  const dirty =
    !saved ||
    identity(saved) !== draftIdentity ||
    status?.binding_revision !== revision;
  useEffect(() => {
    generation.current++;
    setResult("");
    setSecret("");
  }, [draftIdentity, revision]);
  useEffect(() => {
    let live = true;
    generation.current++;
    setStatus(null);
    setResult("");
    setError("");
    void api
      .GET("/api/v1/settings/bindings/{scope}/{key}", {
        params: { path: { scope: "system", key: node } },
      })
      .then(unwrap)
      .then(async (binding) => {
        if (!live) return;
        setSaved(binding.value);
        if (!binding.value) return;
        const metadata = unwrap(
          await api.GET("/api/v1/settings/model-credentials/{key}", {
            params: { path: { key: node } },
          }),
        );
        if (live) setStatus(metadata);
      })
      .catch(() => {
        if (live)
          setError("凭据状态读取失败，请刷新状态或检查服务端安全配置。");
      });
    return () => {
      live = false;
    };
  }, [node, revision, refresh]);
  async function save() {
    if (!status || dirty) return;
    const currentGeneration = generation.current;
    setBusy(true);
    setError("");
    setResult("");
    try {
      const next = unwrap(
        await api.PUT("/api/v1/settings/model-credentials/{key}", {
          params: { path: { key: node } },
          body: {
            secret,
            base_version: status.revision,
            binding_revision: status.binding_revision,
          },
        }),
      );
      if (
        currentGeneration !== generation.current ||
        next.binding_revision !== status.binding_revision
      )
        return;
      setSecret("");
      setStatus(next);
      setResult("API 密钥已加密保存在服务端，可立即用于新请求。");
    } catch (e) {
      if (currentGeneration === generation.current)
        setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }
  async function test() {
    if (!status || dirty) return;
    const currentGeneration = generation.current;
    setBusy(true);
    setError("");
    setResult("");
    try {
      const response = unwrap(
        await api.POST("/api/v1/settings/model-credentials/{key}/test", {
          params: { path: { key: node } },
          body: {
            base_version: status.revision,
            binding_revision: status.binding_revision,
          },
        }),
      );
      if (
        currentGeneration !== generation.current ||
        response.binding_revision !== status.binding_revision ||
        response.credential_revision !== status.revision
      )
        return;
      setResult(
        `${labels[response.state] || "连接未通过，请检查服务端配置"} · ${response.latency_ms} ms${response.usage.total_tokens !== undefined ? ` · ${response.usage.total_tokens} tokens` : ""}`,
      );
    } catch (e) {
      if (currentGeneration === generation.current)
        setError(e instanceof Error ? e.message : "连接测试失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <fieldset disabled={busy} className="editor-fields">
      <h3>API 密钥与连接</h3>
      <p className="muted">
        密钥加密保存在本机服务端，不回显、不写浏览器草稿。已保存密钥优先于同名环境变量；服务地址变化需重新保存密钥。
      </p>
      <p>
        {status
          ? {
              stored: "已保存服务端密钥",
              environment: "使用进程环境变量",
              none: "尚未配置密钥",
              endpoint_mismatch: "密钥地址不匹配，请重新保存",
            }[status.source]
          : "先保存模型配置；继承节点请到类别默认配置密钥。"}
      </p>
      {dirty && <p>模型有未保存修改或版本已变化，请先保存模型配置。</p>}
      <label className="field">
        API 密钥
        <input
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          maxLength={4096}
          value={secret}
          onChange={(e) => {
            generation.current++;
            setResult("");
            setSecret(e.target.value);
          }}
        />
      </label>
      <button
        disabled={dirty || !status || !secret}
        onClick={() => void save()}
      >
        保存 API 密钥
      </button>
      <button onClick={() => setRefresh((v) => v + 1)}>刷新凭据状态</button>
      <p className="muted">
        连接测试会向已保存的文本模型发送一个小请求，可能消耗供应商用量。
      </p>
      <button
        disabled={dirty || !status || value?.capability !== "text" || !!secret}
        onClick={() => void test()}
      >
        测试已保存的连接
      </button>
      {secret && <p className="muted">请先保存输入的密钥，再测试连接。</p>}
      {error && <p role="alert">{error}</p>}
      {!dirty && result && <p role="status">{result}</p>}
    </fieldset>
  );
}
