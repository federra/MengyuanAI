import { test, expect } from '@playwright/test';
import { setupStrictEntityPage } from './fixtures/entity-strict';

test('generated current image becomes savable and saves the actual output file', async ({ page }) => {
  const fx = await setupStrictEntityPage(page);
  await page.route('**/reference-images', r => r.fulfill({json:[{id:'generated-ref',entity_id:fx.ids.character,entity_version_id:'10000000-0000-4000-8000-000000000000',file_id:fx.ids.outputFile,stale:false,confirmed:false,name:'邮差'}]}));
  await page.getByRole('button',{name:'角色管理',exact:true}).click();
  const d=page.getByRole('dialog',{name:'角色管理',exact:true});
  await expect(d.locator('.catalog-image')).toBeVisible();
  await expect(d.getByRole('button',{name:'保存修改',exact:true})).toBeEnabled();
  expect(fx.state.batchRequests).toHaveLength(0);
  await d.getByRole('button',{name:'保存修改',exact:true}).click();
  await expect(d.getByRole('status')).toContainText('已统一保存');
  expect(fx.state.saveRequests[0].body.items).toEqual([expect.objectContaining({id:fx.ids.character,output_file_id:fx.ids.outputFile,input_file_id:null})]);
  await d.getByRole('button',{name:'关闭元素管理'}).click();
  await page.getByRole('button',{name:'角色管理',exact:true}).click();
  await expect(d.locator('.catalog-image')).toHaveAttribute('src',new RegExp(fx.ids.outputFile));
});

test('stale generated image cannot create a selection draft', async ({ page }) => {
  const fx = await setupStrictEntityPage(page);
  await page.route('**/reference-images', r => r.fulfill({json:[{id:'stale-ref',entity_id:fx.ids.character,entity_version_id:'old-version',file_id:fx.ids.outputFile,stale:true,confirmed:false,name:'邮差'}]}));
  await page.getByRole('button',{name:'角色管理',exact:true}).click();
  const d=page.getByRole('dialog',{name:'角色管理',exact:true});
  await expect(d.getByLabel('元素名称').first()).toHaveValue('邮差');
  await page.waitForResponse(r=>r.url().endsWith('/reference-images'));
  await expect(d.getByRole('button',{name:'保存修改',exact:true})).toBeDisabled();
  expect(fx.writes).toHaveLength(0);
});
