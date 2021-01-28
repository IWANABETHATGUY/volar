import type { TsApiRegisterOptions } from '../types';
import {
	Position,
	WorkspaceEdit,
	Location,
	TextEdit,
} from 'vscode-languageserver/node';
import {
	tsLocationToVueLocationsRaw,
	findSourceFileByTsUri,
} from '../utils/commons';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { SourceFile } from '../sourceFiles';
import { TsMappingData } from '../utils/sourceMaps';
import * as globalServices from '../globalServices';

export function register({ sourceFiles, tsLanguageService }: TsApiRegisterOptions) {
	return (document: TextDocument, position: Position, newName: string) => {
		const sourceFile = sourceFiles.get(document.uri);
		if (!sourceFile) return;
		const range = { start: position, end: position };

		const tsResult = getTsResult(sourceFile);
		if (tsResult.changes && Object.keys(tsResult.changes).length) {
			return tsResult;
		}

		const htmlResult = getHtmlResult(sourceFile);
		if (htmlResult.changes && Object.keys(htmlResult.changes).length) {
			return htmlResult;
		}

		const cssResult = getCssResult(sourceFile);
		if (cssResult.changes && Object.keys(cssResult.changes).length) {
			return cssResult;
		}

		function getTsResult(sourceFile: SourceFile) {
			let vueEdits: WorkspaceEdit[] = [];
			let tsLocs: Location[] = [];

			for (const sourceMap of sourceFile.getTsSourceMaps()) {
				// let startWithStyle = false;
				// for (const tsLoc of sourceMap.sourceToTargets(range)) {
				// 	if (tsLoc.data.capabilities.rename) {
				// 		if (tsLoc.data.vueTag === 'style') {
				// 			startWithStyle = true;
				// 		}
				// 	}
				// }
				// if (startWithStyle && newName.startsWith('.')) {
				// 	newName = newName.substr(1);
				// }
				for (const tsLoc of sourceMap.sourceToTargets(range)) {
					if (!tsLoc.data.capabilities.rename) continue;
					if (
						tsLoc.data.capabilities.rename === true
						|| tsLoc.data.capabilities.rename.in
					) {
						let _newName = newName;
						if (tsLoc.data.beforeRename) {
							_newName = tsLoc.data.beforeRename(newName);
						}

						const tsEdit = worker(sourceMap.targetDocument, tsLoc.range.start, _newName, tsLoc.data.vueTag);
						if (!tsEdit) continue;

						const vueEdit = getSourceWorkspaceEdit(tsEdit);
						vueEdits.push(vueEdit);
					}
				}
			}

			return margeWorkspaceEdits(vueEdits);

			function worker(doc: TextDocument, pos: Position, newName: string, from: TsMappingData['vueTag']) {
				let rename = tsLanguageService.doRename(doc.uri, pos, newName);
				if (!rename) return rename;
				for (const tsUri in rename.changes) {
					const tsEdits = rename.changes[tsUri];
					for (const tsEdit of tsEdits) {
						const tsLoc = { uri: tsUri, range: tsEdit.range };

						if (hasLocation(tsLoc)) continue;
						tsLocs.push(tsLoc);

						const sourceFile_2 = findSourceFileByTsUri(sourceFiles, tsUri);
						if (!sourceFile_2) continue;

						const teleports = sourceFile_2.getTeleports();
						for (const teleport of teleports) {
							if (teleport.document.uri === tsLoc.uri) {
								for (const loc of teleport.findTeleports(tsLoc.range, from)) {
									if (!loc.data.capabilities.rename) continue;
									if (!hasLocation({ uri: tsLoc.uri, range: loc.range })) {
										const newName2 = loc.editRenameText ? loc.editRenameText(newName) : newName;
										const rename2 = worker(teleport.document, loc.range.start, newName2, from);
										if (rename2) {
											rename = margeWorkspaceEdits([rename, rename2]);
										}
									}
								}
							}
						}
					}
				}
				return rename;
			}
			// TODO: use map
			function hasLocation(loc: Location) {
				return !!tsLocs.find(tsLoc =>
					tsLoc.uri === loc.uri
					&& tsLoc.range.start.line === loc.range.start.line
					&& tsLoc.range.start.character === loc.range.start.character
					&& tsLoc.range.end.line === loc.range.end.line
					&& tsLoc.range.end.character === loc.range.end.character
				)
			}
		}
		function getHtmlResult(sourceFile: SourceFile) {
			const result: WorkspaceEdit = { changes: {} };
			for (const sourceMap of sourceFile.getHtmlSourceMaps()) {
				for (const htmlLoc of sourceMap.sourceToTargets(range)) {
					const htmlEdits = globalServices.html.doRename(sourceMap.targetDocument, htmlLoc.range.start, newName, sourceMap.htmlDocument);
					if (!htmlEdits) continue;
					if (!htmlEdits.changes) continue;
					for (const uri in htmlEdits.changes) {
						const edits = htmlEdits.changes[uri];
						for (const htmlEdit of edits) {
							const vueLoc = sourceMap.targetToSource(htmlEdit.range);
							if (!vueLoc) continue;
							const vueUri = sourceMap.sourceDocument.uri;
							if (!result.changes![vueUri]) {
								result.changes![vueUri] = [];
							}
							result.changes![vueUri].push({
								range: vueLoc.range,
								newText: htmlEdit.newText,
							});
						}
					}
				}
			}
			return result;
		}
		function getCssResult(sourceFile: SourceFile) {
			const result: WorkspaceEdit = { changes: {} };
			for (const sourceMap of sourceFile.getCssSourceMaps()) {
				const cssLanguageService = globalServices.getCssService(sourceMap.targetDocument.languageId);
				if (!cssLanguageService) continue;
				for (const cssLoc of sourceMap.sourceToTargets(range)) {
					const cssEdits = cssLanguageService.doRename(sourceMap.targetDocument, cssLoc.range.start, newName, sourceMap.stylesheet);
					if (!cssEdits) continue;
					if (!cssEdits.changes) continue;
					for (const uri in cssEdits.changes) {
						const edits = cssEdits.changes[uri];
						for (const cssEdit of edits) {
							const vueLoc = sourceMap.targetToSource(cssEdit.range);
							if (!vueLoc) continue;
							const vueUri = sourceMap.sourceDocument.uri;
							if (!result.changes![vueUri]) {
								result.changes![vueUri] = [];
							}
							result.changes![vueUri].push({
								range: vueLoc.range,
								newText: cssEdit.newText,
							});
						}
					}
				}
			}
			return result;
		}
		function getSourceWorkspaceEdit(workspaceEdit: WorkspaceEdit) {
			const newWorkspaceEdit: WorkspaceEdit = {
				changes: {}
			};
			for (const tsUri in workspaceEdit.changes) {
				const tsDoc = tsLanguageService.getTextDocument(tsUri);
				const tsEdits = workspaceEdit.changes[tsUri];
				for (const tsEdit of tsEdits) {
					const tsLoc = Location.create(tsUri, tsEdit.range);
					const vueLocs = tsLocationToVueLocationsRaw(tsLoc, sourceFiles);
					for (const [vueLoc, mapedData] of vueLocs) {
						let newText = tsEdit.newText;
						let shouldRename = false;
						if (mapedData) {
							if (mapedData.doRename && tsDoc) {
								newText = mapedData.doRename(tsDoc.getText(tsEdit.range), tsEdit.newText);
							}
							if (
								mapedData.capabilities.rename === true
								|| (typeof mapedData.capabilities.rename === 'object' && mapedData.capabilities.rename.out)
							) {
								shouldRename = true;
							}
						}
						else {
							shouldRename = true;
						}
						if (shouldRename) {
							// if (mapedData?.vueTag === 'style') {
							// 	newText = '.' + newText;
							// }
							const sourceTextEdit = TextEdit.replace(vueLoc.range, newText);
							const sourceUri = vueLoc.uri;
							if (!newWorkspaceEdit.changes![sourceUri]) {
								newWorkspaceEdit.changes![sourceUri] = [];
							}
							newWorkspaceEdit.changes![sourceUri].push(sourceTextEdit);
						}
					}
				}
			}
			return newWorkspaceEdit;
		}
		function margeWorkspaceEdits(workspaceEdits: WorkspaceEdit[]) {
			const newWorkspaceEdit: WorkspaceEdit = {
				changes: {}
			};
			for (const workspaceEdit of workspaceEdits) {
				for (const uri in workspaceEdit.changes) {
					if (!newWorkspaceEdit.changes![uri]) {
						newWorkspaceEdit.changes![uri] = [];
					}
					const edits = workspaceEdit.changes[uri];
					newWorkspaceEdit.changes![uri] = newWorkspaceEdit.changes![uri].concat(edits);
				}
			}
			return newWorkspaceEdit;
		}
	}
}
