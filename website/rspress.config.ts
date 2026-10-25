import { defineConfig } from "@rspress/core";

// hotpot-agent 官网配置：结构参考 https://rspress.rs/zh/（首页 + 指南 + 深入 + 博客 + 更新日志）
export default defineConfig({
	// 站点内容根目录（Markdown 源文件）
	root: "docs",
	// GitHub Pages 项目站部署在 /<repo>/ 子路径，由 CI 通过 RSPRESS_BASE 注入；本地开发默认 /
	base: process.env.RSPRESS_BASE ?? "/",
	// GitHub Pages 不做干净 URL 重写，页面链接需要显式带 .html
	route: {
		cleanUrls: false,
	},
	title: "hotpot-agent",
	description: "基于 Node + TypeScript 的 code agent：更低的成本、更好的效果",
	lang: "zh",
	icon: "/logo.png",
	logo: "/logo.png",
	logoText: "HotPot",
	themeConfig: {
		// 顶部导航
		nav: [
			{
				text: "指南",
				link: "/guide/getting-started",
				activeMatch: "^/guide/",
			},
			{
				text: "深入",
				link: "/advanced/architecture",
				activeMatch: "^/advanced/",
			},
			{
				text: "博客",
				link: "/blog",
				activeMatch: "^/blog",
			},
			{
				text: "更新日志",
				link: "/changelog",
				activeMatch: "^/changelog",
			},
		],
		// 侧边栏：按目录分组
		sidebar: {
			"/guide/": [
				{
					text: "开始",
					items: [
						{ text: "快速开始", link: "/guide/getting-started" },
						{ text: "配置", link: "/guide/configuration" },
					],
				},
				{
					text: "使用",
					items: [
						{ text: "CLI", link: "/guide/cli" },
						{ text: "Web 端", link: "/guide/web" },
						{ text: "跑 Benchmark", link: "/guide/benchmark" },
					],
				},
			],
			"/advanced/": [
				{
					text: "架构",
					items: [
						{ text: "总体架构", link: "/advanced/architecture" },
						{ text: "三层编排", link: "/advanced/orchestration" },
						{ text: "会话日志", link: "/advanced/session-log" },
					],
				},
				{
					text: "配套体系",
					items: [
						{ text: "遥测", link: "/advanced/telemetry" },
						{ text: "Benchmarks", link: "/advanced/benchmarks" },
					],
				},
			],
		},
		// 页脚
		footer: {
			message: "基于 Node + TypeScript 的 code agent",
			copyright: "Copyright © 2026 hotpot-agent",
		},
		// 右上角社交链接
		socialLinks: [
			{
				icon: "github",
				link: "https://github.com/Dada-liu/hotpot-agent",
				mode: "link",
			},
		],
		// 「编辑此页」链接
		editLink: {
			docBaseUrl:
				"https://github.com/Dada-liu/hotpot-agent/tree/main/website/docs",
			text: "在 GitHub 上编辑此页",
		},
		// 显示最后更新时间
		lastUpdated: true,
		// 中文搜索占位符
		searchPlaceholderText: "搜索文档",
		// 大纲标题
		outlineTitle: "目录",
	},
});
