# 接入契约

## 运行时依赖

自研编辑器直接依赖：

- `react`
- `react-dom`
- `lucide-react`
- Vite 的 `import.meta.glob` 和 `import.meta.env.DEV`

它不导入或调用 `@axhub/annotation`。目标项目可以同时使用官方标注运行时，但两者的数据源和 UI 是独立的。

## 安装器写入内容

默认目标结构：

```text
<project-root>/
|-- src/prototypes/<prototype-id>/
|   |-- PrototypeAnnotationLayer.tsx
|   |-- AnnotationRichTextEditor.tsx
|   |-- AnnotationMarkdownViewer.tsx
|   |-- annotation.css
|   |-- annotation-layer.json
|   |-- annotation-sets/
|   |-- version-overviews/
|   `-- .prototype-annotation-editor.json
`-- vite-plugins/
    `-- prototypeAnnotationLayerPlugin.ts
```

安装器只部署运行时和初始化缺失的数据目录，不修改原型入口或 Vite 配置。宿主差异需要由代理阅读代码后做小范围接入。

## 原型入口

在能够获得当前页面 ID 和标题的位置挂载一次标注层：

```tsx
import PrototypeAnnotationLayer from './PrototypeAnnotationLayer';
import './annotation.css';

<PrototypeAnnotationLayer
  currentPageId={currentPageId}
  currentPageTitle={currentPageTitle}
  prototypeId="example-prototype"
  workspaceSelector=".prototype-workspace"
/>
```

如果业务组件支持 render prop，优先延续该模式：

```tsx
<PrototypeApp
  renderAnnotationLayer={({ currentPageId, currentPageTitle }) => (
    <PrototypeAnnotationLayer
      currentPageId={currentPageId}
      currentPageTitle={currentPageTitle}
    />
  )}
/>
```

不要从 URL 文本或页面标题反推页面 ID；使用宿主已有的稳定页面状态。

## 布局类名

安装器会将资产中的默认类名替换为目标项目类名：

- `workspace-selector`：可框选内容区域。
- `layout-root-class`：整个原型布局根节点，只能是单个 CSS 类名。
- `layout-shell-class`：打开右侧标注面板时需要缩窄的内容壳。
- `split-class`：标注面板打开时临时加到布局根节点的类。

目标 CSS 的核心行为是：

```css
.<layout-root-class> {
  --prototype-annotation-panel-width: clamp(320px, 25vw, 430px);
}

.<split-class> .<layout-shell-class> {
  padding-right: var(--prototype-annotation-panel-width);
}
```

如果目标项目不能通过右侧 padding 实现分屏，应在安装后只调整这三条宿主布局规则，不改标注面板内部样式。

## Vite 配置

在 `vite.config.*` 中导入保存插件：

```ts
import { prototypeAnnotationLayerPlugin } from './vite-plugins/prototypeAnnotationLayerPlugin';
```

只在本地开发服务启用：

```ts
isServe ? prototypeAnnotationLayerPlugin(projectRoot) : null
```

目标配置没有 `isServe` 时，使用 `command === 'serve'` 的等价判断。不要在发布服务器暴露文件写入接口。

建议让 Vite watcher 忽略：

```text
**/annotation-sets/**/*.json
**/version-overviews/**/*.json
```

这能避免保存单条标注时触发整个原型刷新。

## 稳定锚点

为重要模块添加稳定属性：

```tsx
<section data-prototype-annotation-anchor="order-table">
```

锚点值在同一原型内应稳定且唯一。不要把随机 ID、数组下标或会随文案变化的值作为唯一锚点。
