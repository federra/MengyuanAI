import {test,expect} from '@playwright/test';
import {setupStrictEntityPage} from './fixtures/entity-strict';
test('full image preview closes with Escape without losing the manager draft',async({page})=>{
 const fx=await setupStrictEntityPage(page);
 await page.route('**/reference-images',r=>r.fulfill({json:[{id:'r',entity_id:fx.ids.character,entity_version_id:'10000000-0000-4000-8000-000000000000',file_id:fx.ids.outputFile,stale:false,confirmed:false,name:'邮差'}]}));
 await page.getByRole('button',{name:'角色管理',exact:true}).click();
 const d=page.getByRole('dialog',{name:'角色管理',exact:true});
 await expect(d.getByRole('button',{name:'邮差图片预览'})).toBeEnabled();
 await d.getByLabel('元素名称').first().fill('邮差草稿');
 await d.getByRole('button',{name:'邮差草稿图片预览'}).click();
 const preview=page.getByRole('dialog',{name:'完整图片',exact:true});
 await expect(preview.getByRole('img')).toHaveAttribute('src',new RegExp(fx.ids.outputFile));
 const headerBox=await preview.locator('header').boundingBox(),imageBox=await preview.getByRole('img').boundingBox();
 expect(headerBox!.y+headerBox!.height).toBeLessThanOrEqual(imageBox!.y);
 await page.keyboard.press('Escape');
 await expect(preview).toHaveCount(0);
 await expect(d).toBeVisible();await expect(d.getByLabel('元素名称').first()).toHaveValue('邮差草稿');
 expect(fx.writes).toHaveLength(0);
});
test('reference count excludes empty placeholders and includes one file',async({page})=>{
 const fx=await setupStrictEntityPage(page);
 await page.route('**/files',r=>r.fulfill({json:[{id:fx.ids.outputFile,mime:'image/png',filename:'图片.png'}]}));
 await page.route('**/media/reference-bindings',r=>r.fulfill({json:[{shot_id:fx.ids.shot,ref_id:fx.ids.firstCharacterRef,entity_id:fx.ids.character,file_id:fx.ids.outputFile,revision:2},{shot_id:fx.ids.shot,ref_id:fx.ids.secondCharacterRef,entity_id:fx.ids.secondCharacter,file_id:null,revision:1}]}));
 await expect(page.getByLabel('角色图片数量')).toHaveText('1');
 for(const k of ['场景','道具','站位'])await expect(page.getByLabel(k+'图片数量')).toHaveText('0');
 expect(fx.writes).toHaveLength(0);
});
