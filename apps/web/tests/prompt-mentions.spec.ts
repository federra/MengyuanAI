import { test, expect } from "@playwright/test";
import { projectMentions, editMentions, inlineCharacterMentions } from "../src/promptMentions";
import { setupStrictEntityPage } from "./fixtures/entity-strict";
test("mentions preserve distinct IDs with same names, ordinary edits and renames", () => {
  const names = new Map([
    ["one", "邮差"],
    ["two", "邮差"],
  ]);
  const raw = "邮差@[one]走向@[two]";
  expect(projectMentions(raw, names).text).toBe("邮差@邮差走向@邮差");
  expect(editMentions(raw, "今天邮差@邮差走向@邮差", names)).toBe("今天" + raw);
  expect(
    projectMentions(
      raw,
      new Map([
        ["one", "新人"],
        ["two", "邮差"],
      ]),
    ).text,
  ).toBe("邮差@新人走向@邮差");
  expect(editMentions(raw, "邮差走向@邮差", names)).toBe("邮差走向@[two]");
});
test("at opens actual image picker and inserts named persisted reference", async ({
  page,
}) => {
  const fx = await setupStrictEntityPage(page);
  await page.route("**/reference-images", (r) =>
    r.fulfill({
      json: [
        {
          id: "generated-ref",
          entity_id: fx.ids.character,
          entity_version_id: "10000000-0000-4000-8000-000000000000",
          file_id: fx.ids.outputFile,
          kind: "character",
          name: "邮差",
          stale: false,
          confirmed: false,
        },
      ],
    }),
  );
  await page.route("**/files", (r) =>
    r.fulfill({
      json: [
        { id: fx.ids.outputFile, mime: "image/png", filename: "角色图.png" },
      ],
    }),
  );
  const input = page
    .getByRole("textbox", { name: "提示词", exact: true })
    .first();
  await page.getByRole("button",{name:"编辑提示词",exact:true}).first().click();
  await input.fill("邮差");
  await input.press("End");
  await input.pressSequentially("@");
  const d = page.getByRole("dialog", { name: "选择引用图片" });
  await expect(d).toBeVisible();
  await d.getByRole("button", { name: /邮差.*角色/ }).click();
  await expect(input).toHaveValue("邮差（@邮差）");
  await page.getByRole('button',{name:'返回图片链接预览'}).first().click();
  await page.getByRole('link',{name:'@邮差',exact:true}).first().click();
  const preview=page.getByRole('dialog',{name:'完整图片'});
  await expect(preview.getByRole('img')).toHaveAttribute('src',new RegExp(fx.ids.outputFile));
  await page.keyboard.press('Escape');await expect(preview).toHaveCount(0);
  expect(fx.state.batchRequests).toHaveLength(0);
  await page.reload();
  await page
    .locator(".cards article")
    .filter({ hasText: "三元素项目A" })
    .getByRole("button", { name: "继续创作 →" })
    .click();
  await page.getByRole("button", { name: "4　分镜" }).click();
  await expect(page.getByLabel("提示词预览").first()).toContainText("邮差（@邮差）");
});

test('legacy tail role references move by ID and remain idempotent',()=>{
 const names=new Map([['r','阿伦·韦克']]);
 const raw='外景珠峰，阿伦·韦克身穿装备。 @[r] @[scene]';
 const expected='外景珠峰，阿伦·韦克（@[r]）身穿装备。  @[scene]';
 expect(inlineCharacterMentions(raw,names)).toBe(expected);
 expect(inlineCharacterMentions(expected,names)).toBe(expected);
 expect(inlineCharacterMentions(raw,new Map([['r','阿伦·韦克'],['other','阿伦·韦克']]))).toBe(raw);
 expect(inlineCharacterMentions('小明叔叔 @[a]',new Map([['a','小明'],['b','小明叔叔']]))).toBe('小明叔叔 @[a]');
});
