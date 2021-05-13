import { execSync } from 'child_process';

/**
 *
 * @param millesec Number of milliseconds to wait
 * @returns Promise resolution after the set time
 */
export function wait(millesec: number) {
	return new Promise(resolve => setTimeout(resolve, millesec));
}

/**
 * Use execSync to execute a command
 *
 * @param command Command line command to run
 * @param option execSync options
 * @returns The stdout from the command
 */
export function execute(command: string, option?: any) {
	return execSync(command, option).toString();
}
