import { test, expect } from '@playwright/test';
import { setupStrictEntityPage } from './fixtures/entity-strict';
for (const theme of ['light', 'dark', 'sky', 'noir']) test(`polish ${theme}: aligned controls and labelled squares`, async ({ page }) => {
  await setupStrictEntityPage(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.getByLabel('UI主题').selectOption(theme);
  await expect(page.locator('.reference-kind-label')).toHaveText(['角色图','场景图','道具图','站位图']);
  expect(await page.locator('.board-table th').evaluateAll(ns => ns.every(n => getComputedStyle(n).textAlign === 'center'))).toBe(true);
  const heights = await page.locator('.dialogue-line input:visible,.dialogue-line .mic-button:visible,.dialogue-line .delete-line:visible').evaluateAll(ns => ns.map(n => n.getBoundingClientRect().height));
  expect(heights.every(h => h === 32)).toBe(true);
  await expect(page.locator('.heading-project-info')).toBeVisible();
  for (const kind of ['角色','场景','道具']) {
    await page.getByRole('button', { name: kind+'管理', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: kind+'管理', exact: true });
    expect(await dialog.locator('th').evaluateAll(ns => ns.every(n => getComputedStyle(n).textAlign === 'center'))).toBe(true);
    await expect(dialog.locator('.catalog-image-actions').first()).toBeVisible();
    const groups = await dialog.locator('.catalog-image-actions').evaluateAll(ns => ns.map(n => [...n.children].map(x => { const r=x.getBoundingClientRect(); return {y:r.y,height:r.height,width:r.width}; })));
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) { expect(group[0].height).toBe(32); expect(group[1].height).toBe(32); expect(group[0].y).toBe(group[1].y); expect(group[0].width).toBe(group[1].width); }
    await expect(dialog.getByText('确认生成图片', {exact:true})).toHaveCount(0);
    await dialog.screenshot({ path: `test-results/polish-${theme}-${kind}.png` });
    await dialog.getByRole('button',{ name:'关闭元素管理' }).click();
  }
});

test('project deletion menu cancels safely and keeps server conflict visible', async ({ page }) => {
  const fx = await setupStrictEntityPage(page);
  await page.getByRole('button',{name:'项目',exact:true}).click();
  const card = page.locator('.cards article').filter({hasText:'三元素项目A'});
  await card.getByLabel('三元素项目A项目菜单').click();
  await card.getByRole('button',{name:'删除项目',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'删除项目',exact:true});
  await dialog.getByRole('button',{name:'取消',exact:true}).click();
  expect(fx.writes).toHaveLength(0);
  let calls=0;
  await page.route('**/api/v1/projects/*?revision=*', async route=> { calls++; await route.fulfill({status:409,json:{detail:'项目仍有活动或结果未明的任务'}}); });
  await card.getByRole('button',{name:'删除项目',exact:true}).click();
  await dialog.getByRole('button',{name:'确认删除'}).click();
  await expect(dialog.getByRole('alert')).toContainText('结果未明');
  await expect(card).toBeAttached();
  expect(calls).toBe(1);
});
