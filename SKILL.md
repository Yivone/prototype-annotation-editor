---
name: prototype-annotation-editor
description: 将自研原型标注编辑器安装、更新或诊断到 React + Vite 原型项目，提供可视化框选、富文本说明、多人独立标注文件、调整版本、版本概览和本地保存。用户提到安装标注功能、复用 ips-annotated 标注层或维护 annotation-sets/version-overviews 时使用；不用于官方 @axhub/annotation 的 AnnotationViewer 数据维护。
---

# 自研原型标注编辑器

## 目标

把本 Skill 自带的标注编辑器部署到目标项目，并完成宿主接入和验证。运行时独立于 `@axhub/annotation`，不要为了使用本 Skill 额外安装官方标注包。

## 支持范围

- React 18、Vite 5 及兼容版本。
- 默认目录约定为 `src/prototypes/<prototype-id>` 和 `vite-plugins/`。
- 标注查看可进入发布构建；编辑和文件回写仅在 Vite 本地开发环境开放。
- 标注数据由目标项目管理，不从 Skill 目录直接运行。

其他框架、非 Vite 构建或数据目录不符合约定时，不要强行套用安装器；先说明不兼容点，再按用户决定适配。

## 安装流程

1. 确认项目根目录和目标 `prototype-id`。存在多个候选且无法从任务判断时，先询问用户。
2. 读取目标原型入口、工作区 DOM、布局根节点、内容壳和 `vite.config.*`。
3. 阅读 [接入契约](references/integration.md)，确定工作区选择器、布局根类名、分屏状态类名、内容壳类名和默认标注人 ID。
4. 从本 Skill 根目录运行：

   ```bash
   node scripts/install.mjs \
     --project-root <project-root> \
     --prototype-id <prototype-id> \
     --workspace-selector <selector> \
     --layout-root-class <class> \
     --layout-shell-class <class> \
     --split-class <class> \
     --owner-id <owner-id>
   ```

5. 按安装器输出和接入契约修改目标原型入口与 `vite.config.*`。使用项目现有挂载方式，不要为了接入标注重构业务页面。
6. 检查 `react`、`react-dom` 和 `lucide-react`。只安装缺少的依赖；需要联网安装时遵循当前环境审批规则。
7. 运行诊断：

   ```bash
   node scripts/doctor.mjs --project-root <project-root> --prototype-id <prototype-id>
   ```

8. 运行项目已有的 typecheck、测试和预览就绪检查，并在浏览器验证查看、编辑、框选和保存。

## 更新流程

重新执行 `install.mjs`。安装器根据 `.prototype-annotation-editor.json` 判断已安装文件是否被人工修改：

- 未修改文件可自动升级。
- 已修改文件默认停止，先阅读差异并保留项目定制。
- `--force` 会覆盖冲突文件，只有用户明确同意覆盖后才能使用。

永远不要覆盖 `annotation-layer.json`、`annotation-sets/` 或 `version-overviews/` 中的业务数据。

## 数据与行为

需要迁移、生成或检查标注数据时，阅读 [数据格式](references/data-schema.md)。保持以下不变量：

- 每个标注人只写自己的 `annotation-sets/<owner-id>/`。
- 标注 ID 和版本 ID 必须是安全的小写连字符格式。
- 富文本在渲染和保存前继续执行现有 HTML 清理。
- 单次保存请求保持 25 MB 上限。
- 发布环境只读，本地开发环境才允许编辑和回写文件。

## 验收

- 普通业务交互在标注层关闭、查看和编辑三种状态下均可使用。
- 查看面板按当前页面过滤标注，marker 与卡片双向联动。
- 新增框选优先使用稳定 DOM 锚点，无法稳定定位时保留百分比区域。
- 保存后只变更当前标注人的文件；刷新页面后内容仍存在。
- 版本概览、调整版本、图片粘贴、表格编辑和 HTML 清理保持可用。
- `doctor.mjs` 无错误，项目 typecheck 和预览检查通过。
