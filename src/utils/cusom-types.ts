export interface StatusBarElement extends HTMLElement {
	doReset?: () => void;
	doDisplayError?: () => void;
	doDisplayRunning?: () => void;
}
