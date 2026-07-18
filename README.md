# STACKS ATLAS

> The Stacks Project 依赖关系三维星图可视化 —— 主体由 **Kimi K3 集群** 生成完成。

**简体中文** ｜ [English](./README.en.md)

[![在线体验](https://img.shields.io/badge/在线体验-Kimi%20Link-2EA44F?logo=vercel&logoColor=white)](https://stacks-atlas.ok.kimi.link/)
[![Built with Kimi K3](https://img.shields.io/badge/Built%20with-Kimi%20K3-FF6B35)](https://kimi.moonshot.cn/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-5-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)
[![three.js](https://img.shields.io/badge/three.js-r185-000000?logo=threedotjs&logoColor=white)](https://threejs.org/)
[![GitHub stars](https://img.shields.io/github/stars/inorganben/stacks-atlas?style=social)](https://github.com/inorganben/stacks-atlas/stargazers)
[![GitHub last commit](https://img.shields.io/github/last-commit/inorganben/stacks-atlas)](https://github.com/inorganben/stacks-atlas/commits)

<p align="center">
  <img src="img/1.png" alt="overview" width="720" />
</p>
<p align="center">
  <img src="img/2.png" alt="detail" width="355" />
  <img src="img/3.png" alt="tour" width="355" />
</p>

## 关于 The Stacks Project

[The Stacks Project](https://stacks.math.columbia.edu/) 是一个协作编写、以 LaTeX 写就的代数几何学百科式参考项目，目标是从交换代数、层论一路覆盖到代数栈、导出范畴等现代主题，所有论述自包含、可追溯。本项目将其中的定义、引理、定理以及它们之间的依赖关系抽取出来，组织为一张可交互的三维星图。

## 功能

- 全量节点与依赖边一次性渲染（InstancedMesh + LineSegments）
- 节点详情面板内嵌 KaTeX 渲染原始数学公式
- FlexSearch 全文搜索、按标签过滤、最短路径查找（Web Worker）
- 相机机位预设与自动巡游（TOUR）
- URL 参数深链、键盘快捷键、三档渲染质量

## 本地部署

需要 Node.js 18+。

```bash
git clone https://github.com/inorganben/stacks-atlas.git
cd stacks-atlas
npm install
npm run dev      # 开发服务器，默认 http://localhost:5173
npm run build    # 生产构建到 dist/
npm run preview  # 预览生产构建
```

## 技术栈

Vite · React 18 · TypeScript · three.js · @react-three/fiber · @react-three/drei · @react-three/postprocessing · zustand · KaTeX · FlexSearch

## 致谢

原始内容来自 [The Stacks Project](https://stacks.math.columbia.edu/)。
