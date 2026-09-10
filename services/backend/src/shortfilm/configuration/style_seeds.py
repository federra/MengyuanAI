"""Editable first-install presets; never replace existing versions."""
STYLES = {
    '现代电影': '现代电影风格：自然可信的材质与空间比例，柔和主光与环境反射光，低饱和中性色、适度冷暖对比，保留暗部层次。画面构图清晰，主体突出，景深随景别变化；运镜平稳、表演克制、动作符合重力和惯性。全片人物造型、服装、道具与色调保持一致，避免过度锐化、塑料皮肤和闪烁。按剧本呈现主体，不将非真人角色改成人类。',
    '古风写意': '古风写意风格：东方水墨与工笔融合，宣纸纹理、细腻衣纹和山石层次，墨色、青绿与暖金少量点缀，柔和侧光和薄雾，留白构图。人物、建筑和道具遵循剧本时代设定；衣物与雾气运动舒缓，镜头缓推缓移，保持空间连续。全片线条、笔触、色板与角色造型一致，避免现代物件、风格突变和纹理闪烁；不改写剧情。',
    '清新动画': '清新动画风格：非真人卡通角色，圆润清楚的轮廓，柔和三维卡通材质，明亮低对比照明、温暖粉彩配色，简洁且有层次的环境。表情可读、动作有自然预备和跟随，适度夸张但不穿模；镜头平稳，主体与背景分离。全片固定角色比例、服饰、道具设计和色板，避免真人皮肤、恐怖细节、抖动和逐帧造型漂移。',
}


def seed_styles(db):
    from uuid import NAMESPACE_URL, uuid5

    from sqlalchemy import select

    from shortfilm.config_models import Resource, ResourceVersion
    for name, content in STYLES.items():
        rid = uuid5(NAMESPACE_URL, 'shortfilm:style:' + name)
        if db.get(Resource, rid) or db.scalar(select(Resource.id).where(Resource.name == name, Resource.kind == 'style', Resource.stage == 'video')):
            continue
        db.add(Resource(id=rid, name=name, kind='style', stage='video', revision=1))
        db.flush()
        db.add(ResourceVersion(resource_id=rid, revision=1, name=name, content=content, required_variables=[]))
    db.flush()
