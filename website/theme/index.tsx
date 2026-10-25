// 自定义主题入口：全局样式覆盖 + hero 图片悬浮组合，其余组件沿用默认主题
import { normalizeImagePath } from "@rspress/core/runtime";
import { HomeHero as BasicHomeHero } from "@rspress/core/theme-original";
import type { ComponentProps } from "react";
import "./index.css";

// hero 右侧图：默认展示三层 agent 组合，悬浮时切换为 logo
// （main 在上方，work / task 在下方并叠在 main 之上，部分遮盖 main）
const heroImage = (
	<div className="hero-team">
		<img
			className="hero-team__logo"
			src={normalizeImagePath("/logo.png")}
			alt="hotpot-agent logo"
		/>
		<img
			className="hero-team__agent hero-team__agent--main"
			src={normalizeImagePath("/main_agent.png")}
			alt="main agent"
		/>
		<img
			className="hero-team__agent hero-team__agent--work"
			src={normalizeImagePath("/work_agent_active.webp")}
			alt="work agent"
		/>
		<img
			className="hero-team__agent hero-team__agent--task"
			src={normalizeImagePath("/task_agent_active.webp")}
			alt="task agent"
		/>
	</div>
);

function HomeHero(props: ComponentProps<typeof BasicHomeHero>) {
	return <BasicHomeHero {...props} image={heroImage} />;
}

export { HomeHero };
export * from "@rspress/core/theme-original";
