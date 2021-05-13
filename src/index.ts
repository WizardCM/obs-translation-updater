import axios from 'axios';
import * as path from 'path';
import * as fse from 'fs-extra';
import * as Zip from 'adm-zip';
import * as core from '@actions/core';
import Crowdin, { ReportsModel, UsersModel } from '@crowdin/crowdin-api-client';

import { wait, execute } from './utils';
import { projectId, rootDir, tempDir, submodules } from './constants';
import strings from './strings';

const { reportsApi, translationsApi, usersApi, projectsGroupsApi } = new Crowdin({
	token: process.env.CROWDIN_PERSONAL_TOKEN!
});

/*
Everything is broken down into smaller steps which makes it easier
to maintain and test. Just comment out the call of a step.
It also allows a controlled step-by-step
and concurrent execution of functions.
*/

/**
 * Clears a directory excluding `en-US.ini` files.
 *
 * @param path Directory to clear
 */
function emptyTranslationDir(path: string): void {
	for (const file of fse.readdirSync(path)) {
		if (file !== strings.filename.enUS) {
			fse.removeSync(file);
		}
	}
}

/**
 * Remove all translations to prevent keeping dropped languages.
 */
function removePreviousTranslations(): void {
	emptyTranslationDir(path.join('UI', 'data', 'locale'));
	emptyTranslationDir(path.join('plugins', 'enc-amf', 'resources', 'locale'));
	for (const file of fse.readdirSync('plugins')) {
		const dirPath = path.join('plugins', file, 'data', 'locale');
		if (fse.existsSync(dirPath) && fse.lstatSync(dirPath).isDirectory()) {
			emptyTranslationDir(dirPath);
		}
	}
}

/**
 * Uses `git shortlog` to get a list Git contributors.
 *
 * @returns List of contributors, with heading
 */
function getGitContributors(): string {
	let output = `${strings.heading.contributors}:\n`;
	for (const line of execute('git shortlog --all -sn --no-merges').split('\n')) {
		const contributor = line.substring(line.indexOf('\t') + 1);
		if (contributor !== strings.committer.name) {
			output += ' ' + line.substring(line.indexOf('\t') + 1) + '\n';
		}
	}
	return output;
}

/**
 * Gets all translators from the Crowdin project.
 *
 * @returns {Promise<string>} List of translators, with heading
 */
async function getTranslators(): Promise<string> {
	// blocked users
	const blockedUsers: number[] = [];
	for (const blockedUser of (await usersApi.listProjectMembers(projectId, undefined, UsersModel.Role.BLOCKED, undefined, 500)).data) {
		blockedUsers.push(blockedUser.data.id);
	}
	// report
	const reportRequests = [];
	for (const language of (await projectsGroupsApi.getProject(projectId)).data.targetLanguageIds) {
		/**
		 *
		 * @returns Crowdin report of "top members"
		 */
		async function reportRequest() {
			const { status: reportStatus, identifier: reportId } = (
				await reportsApi.generateReport(projectId, {
					name: 'top-members',
					schema: {
						unit: ReportsModel.Unit.STRINGS,
						format: ReportsModel.Format.JSON,
						dateFrom: '2014-01-01T00:00:00+00:00',
						dateTo: '2030-01-01T00:00:00+00:00',
						languageId: language
					}
				})
			).data;
			let finished = reportStatus === 'finished';
			while (!finished) {
				await wait(3000);
				finished = (await reportsApi.checkReportStatus(projectId, reportId)).data.status === 'finished';
			}
			return (await axios.get((await reportsApi.downloadReport(projectId, reportId)).data.url)).data;
		}
		reportRequests.push(reportRequest);
	}

	const topMembers = new Map<string, string[]>();
	for (const reportData of await Promise.all(reportRequests.map(async a => await a()))) {
		const languageName: string = reportData.language.name;
		let members: string[];
		if (topMembers.has(languageName)) {
			members = topMembers.get(languageName)!;
		} else {
			members = [];
		}
		for (const user of reportData.data) {
			const fullName: string = user.user.fullName;
			// don't list deleted and blocked accounts
			if (fullName === 'REMOVED_USER' || blockedUsers.includes(Number(user.user.id))) {
				continue;
			}
			if (user.translated === 0 && user.approved === 0) {
				continue;
			}
			members.push(fullName);
		}
		topMembers.set(languageName, members);
	}

	let output = `${strings.heading.translators}:\n`;
	for (const language of new Map([...topMembers].sort((a, b) => String(a[0]).localeCompare(b[0]))).keys()) {
		output += ' ' + language + ':\n';
		for (const user of topMembers.get(language)!) {
			output += '  ' + user + '\n';
		}
	}
	return output;
}

/**
 * Builds the Crowidn project, trims the translation files and moves them to their directories.
 *
 * @param skipBuildCreation Skips the build creation.
 */
async function projectBuild(skipBuildCreation: boolean): Promise<void> {
	let buildId: number = -1;
	if (skipBuildCreation) {
		const { id, status } = (await translationsApi.listProjectBuilds(projectId, undefined, 1)).data[0].data;
		if (status === 'finished') {
			buildId = id;
		}
	}
	if (buildId === -1) {
		const { id, status } = (await translationsApi.buildProject(projectId, { skipUntranslatedStrings: true })).data;
		let finished = status === 'finished';
		while (!finished) {
			await wait(3000);
			finished = (await translationsApi.checkBuildStatus(projectId, id)).data.status === 'finished';
		}
		buildId = id;
	}
	const zipFile = new Zip(
		(await axios.get((await translationsApi.downloadTranslations(projectId, buildId)).data.url, { responseType: 'arraybuffer' })).data
	);
	fse.mkdirSync(tempDir);
	for (const zipEntry of zipFile.getEntries()) {
		if (zipEntry.isDirectory) {
			fse.mkdirSync(path.join(tempDir, zipEntry.entryName));
		}
		// remove all empty lines
		let fileContent = zipFile.readAsText(zipEntry).trim();
		while (fileContent.includes('\r\n')) {
			fileContent = fileContent.replace('\r\n', '\n');
		}
		while (fileContent.includes('\n\n')) {
			fileContent = fileContent.replace('\n\n', '\n');
		}
		// discard empty files
		if (fileContent.length === 0) {
			continue;
		}
		fse.writeFileSync(path.join(tempDir, zipEntry.entryName), fileContent + '\n');
	}
	fse.removeSync(path.join(tempDir, 'Website'));
	fse.moveSync(path.join(tempDir, 'enc-amf'), path.join(tempDir, 'plugins', 'enc-amf'));
	fse.moveSync(path.join(tempDir, 'obs-browser'), path.join(tempDir, 'plugins', 'obs-browser'));
	fse.moveSync(path.join(tempDir, 'obs-vst'), path.join(tempDir, 'plugins', 'obs-vst'));
	fse.copySync(path.join(tempDir, 'UI'), 'UI');
	fse.copySync(path.join(tempDir, 'plugins'), 'plugins');
}

/**
 * Build the final string to be saved to the AUTHORS file.
 *
 * @param gitContributors Output of getGitContributors()
 * @param translators  Output of getTranslators()
 */
function generateAuthors(gitContributors: string, translators: string): void {
	fse.writeFileSync(strings.filename.AUTHORS, `${strings.heading.authors}${gitContributors}${translators}`);
}

const detachedSubmodules: string[] = [];

/**
 * Finds submodules uneven with the main repository.
 */
function prepareBuild(): void {
	for (const submodule of submodules) {
		process.chdir(path.join(rootDir, 'plugins', submodule));
		if (execute('git diff master HEAD').length !== 0) {
			detachedSubmodules.push(submodule);
		}
		execute('git checkout master');
	}
	process.chdir(rootDir);
}

/**
 * Pushes all changes to the submodules and the main repository.
 */
function pushChanges(): void {
	execute(`git config --global user.name '${strings.committer.name}'`);
	execute(`git config --global user.email '${strings.committer.email}'`);
	for (const submodule of submodules) {
		process.chdir(path.join(rootDir, 'plugins', submodule));
		if (execute('git status --porcelain').length === 0) {
			continue;
		}
		execute('git add .');
		execute(`git commit -m '${strings.commit.title}'`);
		execute('git push');
	}
	process.chdir(rootDir);
	execute('git add .');
	for (const submodule of detachedSubmodules) {
		execute('git reset -- plugins/' + submodule);
		console.log(submodule + ' has commits not pushed to the main repository. Only pushing to submodule.');
	}
	if (execute('git status --porcelain').length === 0) {
		console.log('No changes in main repository. Skipping push.');
		return;
	}
	execute(`git commit -m '${strings.commit.title}'`);
	execute('git push');
}

/**
 * Generate translated `com.obsproject.Studio.desktop` file.
 */
function desktopFile(): void {
	const filePath = path.join('UI', 'xdg-data', 'com.obsproject.Studio.desktop');
	const desktopFile = fse.readFileSync(filePath, 'utf-8').trim();
	let result = '';
	for (const line of desktopFile.split('\n')) {
		if (line.length === 0) {
			continue;
		}
		if (!(line.startsWith('GenericName[') || line.startsWith('Comment['))) {
			result += line + '\n';
		}
	}
	result += '\n';
	for (const languageFile of fse.readdirSync(path.join(tempDir, 'desktop-entry'))) {
		const languageFileContent = fse.readFileSync(path.join(tempDir, 'desktop-entry', languageFile), 'utf-8').trim();
		if (languageFileContent.length === 0) {
			continue;
		}
		for (const line of languageFileContent.split('\n')) {
			result +=
				line.substring(0, line.indexOf('=')) +
				'[' +
				languageFile.substring(0, languageFile.indexOf('.ini')) +
				']=' +
				line.substring(line.indexOf('"') + 1, line.lastIndexOf('"')) +
				'\n';
		}
	}
	fse.writeFileSync(filePath, result);
}

(async() => {
	try {
		removePreviousTranslations();
		prepareBuild();
		await Promise.all([generateAuthors(getGitContributors(), await getTranslators()), projectBuild(true)]);
		desktopFile();
		fse.removeSync(tempDir);
		pushChanges();
	} catch (error) {
		console.error(error);
		core.setFailed(error);
	}
})();
