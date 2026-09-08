import createClient from 'openapi-fetch';
import type { paths, components } from './generated/api';
export const api = createClient<paths>();
export type Project = components['schemas']['ProjectOut'];
export type MediaFile = components['schemas']['FileOut'];
export type Job = components['schemas']['JobOut'];
export type Settings = components['schemas']['SettingsOut'];
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (!result.response.ok || result.data === undefined) {
    const detail = (result.error as { detail?: unknown } | undefined)?.detail;
    throw new Error(typeof detail === 'string' ? detail : `请求失败（${result.response.status}），请检查输入或服务状态`);
  }
  return result.data;
}
