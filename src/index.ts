const AXIOS = require("axios").default;
import EXEC = require("child_process");
import PATH = require("path");
import FSE = require("fs-extra");
import ZIP = require("adm-zip");
import CORE = require("@actions/core");
import crowdin, { ReportsModel, UsersModel } from "@crowdin/crowdin-api-client";

const { reportsApi, translationsApi, usersApi, projectsGroupsApi } = new crowdin({
	token: process.env.CROWDIN_PERSONAL_TOKEN!
});
const projectId: number = 51028;
const rootDir = PATH.resolve(".");
const tempDir = PATH.resolve(rootDir, "obs-translation-updater");

function wait(millesec: number) {
	return new Promise(resolve => setTimeout(resolve, millesec));
}

function execute(command: string, option?: any) {
	return EXEC.execSync(command, option).toString();
}

/*
Everything is broken down into smaller steps which makes it easier
to maintain and test. Just comment out the call of a step.
It also allows a controlled step-by-step
and concurrent execution of functions.
*/

function emptyTranslationDir(path: string): void {
	for (const file of FSE.readdirSync(path)) {
		if (file !== "en-US.ini") {
			FSE.removeSync(file);
		}
	}
}

// Remove dropped languages that would've otherwise been kept.
function removePreviousTranslations(): void {
	emptyTranslationDir(PATH.join("UI", "data", "locale"));
	emptyTranslationDir(PATH.join("plugins", "enc-amf", "resources", "locale"));
	for (const file of FSE.readdirSync("plugins")) {
		const dirPath = PATH.join("plugins", file, "data", "locale");
		if (FSE.existsSync(dirPath) && FSE.lstatSync(dirPath).isDirectory()) {
			emptyTranslationDir(dirPath);
		}
	}
}

function getGitContributors(): string {
	let output = "Contributors:\n";
	for (var line of execute("git shortlog --all -sn --no-merges").split("\n")) {
		const contributor = line.substring(line.indexOf("\t") + 1);
		if (contributor !== "Translation Updater") {
			output += " " + line.substring(line.indexOf("\t") + 1) + "\n";
		}
	}
	return output;
}

async function getTranslators(): Promise<string> {
	// blocked users
	const blockedUsers: number[] = [];
	for (const blockedUser of (await usersApi.listProjectMembers(projectId, undefined, UsersModel.Role.BLOCKED, undefined, 500)).data) {
		blockedUsers.push(blockedUser.data.id);
	}
	// report
	const reportRequests = [];
	for (const language of (await projectsGroupsApi.getProject(projectId)).data.targetLanguageIds) {
		async function reportRequest() {
			const { status: reportStatus, identifier: reportId } = (
				await reportsApi.generateReport(projectId, {
					name: "top-members",
					schema: {
						unit: ReportsModel.Unit.STRINGS,
						format: ReportsModel.Format.JSON,
						dateFrom: "2014-01-01T00:00:00+00:00",
						dateTo: "2030-01-01T00:00:00+00:00",
						languageId: language
					}
				})
			).data;
			let finished = reportStatus === "finished";
			while (!finished) {
				await wait(3000);
				finished = (await reportsApi.checkReportStatus(projectId, reportId)).data.status === "finished";
			}
			return (await AXIOS.get((await reportsApi.downloadReport(projectId, reportId)).data.url)).data;
		}
		reportRequests.push(reportRequest);
	}

	const topMembers = new Map<string, string[]>();
	for (const reportData of await Promise.all(reportRequests.map(a => a()))) {
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
			if (fullName === "REMOVED_USER" || blockedUsers.includes(parseInt(user.user.id))) {
				continue;
			}
			if (user.translated === 0 && user.approved === 0) {
				continue;
			}
			members.push(fullName);
		}
		topMembers.set(languageName, members);
	}

	let output = "Translators:\n";
	for (const language of new Map([...topMembers].sort((a, b) => String(a[0]).localeCompare(b[0]))).keys()) {
		output += " " + language + ":\n";
		for (const user of topMembers.get(language)!) {
			output += "  " + user + "\n";
		}
	}
	return output;
}

async function projectBuild(skipBuildCreation: boolean): Promise<void> {
	let buildId: number = -1;
	if (skipBuildCreation) {
		const { id, status } = (await translationsApi.listProjectBuilds(projectId, undefined, 1)).data[0].data;
		if (status === "finished") {
			buildId = id;
		}
	}
	if (buildId === -1) {
		const { id, status } = (await translationsApi.buildProject(projectId, { skipUntranslatedStrings: true })).data;
		let finished = status === "finished";
		while (!finished) {
			await wait(3000);
			finished = (await translationsApi.checkBuildStatus(projectId, id)).data.status === "finished";
		}
		buildId = id;
	}
	const zip = new ZIP(
		(await AXIOS.get((await translationsApi.downloadTranslations(projectId, buildId)).data.url, { responseType: "arraybuffer" })).data
	);
	FSE.mkdirSync(tempDir);
	for (const zipEntry of zip.getEntries()) {
		if (zipEntry.isDirectory) {
			FSE.mkdirSync(PATH.join(tempDir, zipEntry.entryName));
		}
		// remove all empty lines
		let fileContent = zip.readAsText(zipEntry).trim();
		while (fileContent.includes("\r\n")) {
			fileContent = fileContent.replace("\r\n", "\n");
		}
		while (fileContent.includes("\n\n")) {
			fileContent = fileContent.replace("\n\n", "\n");
		}
		// discard empty files
		if (fileContent.length === 0) {
			continue;
		}
		FSE.writeFileSync(PATH.join(tempDir, zipEntry.entryName), fileContent + "\n");
	}
	FSE.removeSync(PATH.join(tempDir, "Website"));
	FSE.moveSync(PATH.join(tempDir, "enc-amf"), PATH.join(tempDir, "plugins", "enc-amf"));
	FSE.moveSync(PATH.join(tempDir, "obs-browser"), PATH.join(tempDir, "plugins", "obs-browser"));
	FSE.moveSync(PATH.join(tempDir, "obs-vst"), PATH.join(tempDir, "plugins", "obs-vst"));
	FSE.copySync(PATH.join(tempDir, "UI"), "UI");
	FSE.copySync(PATH.join(tempDir, "plugins"), "plugins");
}

function generateAuthors(gitContributors: string, translators: string): void {
	FSE.writeFileSync(
		"AUTHORS",
		`Original Author: Hugh Bailey ("Jim")\n\nContributors are sorted by their amount of commits / translated strings.\n\n${gitContributors}${translators}`
	);
}

const submodules = ["enc-amf", "obs-browser", "obs-vst"];
let detachedSubmodules: string[] = [];

function prepareBuild(): void {
	for (const submodule of submodules) {
		process.chdir(PATH.join(rootDir, "plugins", submodule));
		if (execute("git diff master HEAD").length !== 0) {
			detachedSubmodules.push(submodule);
		}
		execute("git checkout master");
	}
	process.chdir(rootDir);
}

function pushChanges(): void {
	execute("git config --global user.name 'Translation Updater'");
	execute("git config --global user.email '<>'");
	for (const submodule of submodules) {
		process.chdir(PATH.join(rootDir, "plugins", submodule));
		if (execute("git status --porcelain").length === 0) {
			continue;
		}
		execute("git add .");
		execute("git commit -m 'Update translations from Crowdin'");
		execute("git push");
	}
	process.chdir(rootDir);
	execute("git add .");
	for (const submodule of detachedSubmodules) {
		execute("git reset -- plugins/" + submodule);
		console.log(submodule + " has commits not pushed to the main repository. Only pushing to submodule.");
	}
	if (execute("git status --porcelain").length === 0) {
		console.log("No changes in main repository. Skipping push.");
		return;
	}
	execute("git commit -m 'Update translations from Crowdin'");
	execute("git push");
}

function desktopFile(): void {
	const desktopFile = FSE.readFileSync(PATH.join("UI", "xdg-data", "com.obsproject.Studio.desktop"), "utf-8").trim();
	let result = "";
	for (const line of desktopFile.split("\n")) {
		if (line.length === 0) {
			continue;
		}
		if (!(line.startsWith("GenericName[") || line.startsWith("Comment["))) {
			result += line + "\n";
		}
	}
	result += "\n";
	for (const languageFile of FSE.readdirSync(PATH.join(tempDir, "desktop-entry"))) {
		const languageFileContent = FSE.readFileSync(PATH.join(tempDir, "desktop-entry", languageFile), "utf-8").trim();
		if (languageFileContent.length === 0) {
			continue;
		}
		for (const line of languageFileContent.split("\n")) {
			result +=
				line.substring(0, line.indexOf("=")) +
				"[" +
				languageFile.substring(0, languageFile.indexOf(".ini")) +
				"]=" +
				line.substring(line.indexOf('"') + 1, line.lastIndexOf('"')) +
				"\n";
		}
	}
	FSE.writeFileSync(PATH.join("UI", "xdg-data", "com.obsproject.Studio.desktop"), result);
}

(async () => {
	try {
		removePreviousTranslations();
		prepareBuild();
		await Promise.all([generateAuthors(getGitContributors(), await getTranslators()), projectBuild(true)]);
		desktopFile();
		FSE.removeSync(tempDir);
		pushChanges();
	} catch (error) {
		console.error(error);
		CORE.setFailed(error);
	}
})();
