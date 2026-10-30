import { setIcon } from 'obsidian';

type GenerationState = 'idle' | 'running' | 'error';
const ICONS: Record<GenerationState, string> = {
	idle: 'check-circle-2',
	running: 'refresh-cw',
	error: 'alert-circle',
};

export class GenerationStatus {
	private readonly icon: HTMLElement;

	constructor(private readonly element: HTMLElement) {
		element.classList.add('status-bar-auto-anki');
		this.icon = element.createSpan({ cls: 'status-bar-icon' });
		element.createDiv({ text: 'Auto Anki' });
		this.setState('idle');
	}

	setState(state: GenerationState): void {
		setIcon(this.icon, ICONS[state]);
		this.element.classList.remove('--running');
		this.element.classList.remove('--error');
		if (state !== 'idle') this.element.classList.add(`--${state}`);
	}
}
