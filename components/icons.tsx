import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const baseProps: IconProps = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
};

export function PlusIcon(props: IconProps) {
  return <svg {...baseProps} {...props}><path d="M12 5v14M5 12h14" /></svg>;
}

export function CloseIcon(props: IconProps) {
  return <svg {...baseProps} {...props}><path d="m6 6 12 12M18 6 6 18" /></svg>;
}

export function ResetIcon(props: IconProps) {
  return <svg {...baseProps} {...props}><path d="M4.7 9a8 8 0 1 1-.3 5" /><path d="M4 4v5h5" /></svg>;
}

export function UploadIcon(props: IconProps) {
  return <svg {...baseProps} {...props}><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" /><path d="M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" /></svg>;
}

export function ArrowIcon(props: IconProps) {
  return <svg {...baseProps} {...props}><path d="M5 12h14m-5-5 5 5-5 5" /></svg>;
}

export function SparkIcon(props: IconProps) {
  return <svg {...baseProps} {...props}><path d="M12 2c.7 5.8 4.2 9.3 10 10-5.8.7-9.3 4.2-10 10-.7-5.8-4.2-9.3-10-10 5.8-.7 9.3-4.2 10-10Z" /></svg>;
}
