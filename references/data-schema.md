# 数据格式

## 基础元数据

`annotation-layer.json` 只保存标注层元数据：

```json
{
  "schemaVersion": 1,
  "kind": "prototype-annotation-layer",
  "prototypeId": "example-prototype",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

## 标注文件

每条标注独立存放：

```text
annotation-sets/<owner-id>/<annotation-id>.json
```

核心字段：

```json
{
  "schemaVersion": 1,
  "kind": "prototype-annotation",
  "id": "annotation-order-table-123",
  "ownerId": "user-id",
  "pageId": "orders",
  "title": "订单表格",
  "locator": {
    "selectors": ["[data-prototype-annotation-anchor=\"order-table\"]"],
    "path": [],
    "fingerprint": "section|data-prototype-annotation-anchor=order-table"
  },
  "fallbackRect": {
    "xPercent": 10,
    "yPercent": 20,
    "widthPercent": 40,
    "heightPercent": 30
  },
  "markdown": "",
  "richTextHtml": "<p>说明</p>",
  "versions": [],
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

`locator` 优先恢复 DOM 模块；匹配失败时使用 `fallbackRect`。不要删除 fallback 数据。

## 调整版本

调整版本的 `label` 是用户填写的版本名称；新增或编辑的版本保存时，版本名称、作者和调整说明为必填项。仅校验本次保存的标注中新增或修改的调整版本，其他标注的未完成草稿和已有旧版本不阻止当前标注保存。

`versions[]` 中每个版本还包含 `id`、`markdown`、`richTextHtml`、`adjustmentNote`、`author`、`createdAt` 和 `updatedAt`。旧数据中的 `adjustmentDate` 保留原值，不迁移、不用版本名称覆盖；新建版本保持空值。初始版本仍由标注根字段表示。

## 版本概览

每个版本概览独立存放：

```text
version-overviews/<version-id>.json
```

核心字段为 `id`、`label`、`markdown`、`richTextHtml`、`createdAt` 和 `updatedAt`，并由保存插件补充 `schemaVersion: 1` 和 `kind: prototype-version-overview`。

## 安全约束

- `prototype-id`、标注 ID、版本 ID 使用小写字母、数字和连字符。
- `owner-id` 最长 32 个字符，使用小写字母、数字和连字符。
- 保存插件必须验证目标路径始终位于当前项目和当前原型目录内。
- 富文本禁止 `script`、`style`、`iframe`、`object` 和 `embed`，并移除事件处理属性和危险 URL。
- 图片以内嵌 data URL 保存时仍受单次请求 25 MB 上限约束。
