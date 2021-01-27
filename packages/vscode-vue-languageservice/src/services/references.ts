import {
	Position,
	TextDocument,
	Location,
	Range,
} from 'vscode-languageserver/node';
import { SourceFile } from '../sourceFiles';
import {
	tsLocationToVueLocations,
	findSourceFileByTsUri,
} from '../utils/commons';
import type * as ts2 from '@volar/vscode-typescript-languageservice';
import * as globalServices from '../globalServices';
import { TsMappingData, TsSourceMap } from '../utils/sourceMaps';
import * as dedupe from '../utils/dedupe';

export function register(sourceFiles: Map<string, SourceFile>, tsLanguageService: ts2.LanguageService, getGlobalTsSourceMaps?: () => Map<string, { sourceMap: TsSourceMap }>) {
	return (document: TextDocument, position: Position, ingoreTsResult = false) => {
		const range = { start: position, end: position };

		if (document.languageId !== 'vue') {
			let result = getTsResultWorker(document, range, 'script');
			if (ingoreTsResult) {
				result = result.filter(loc => sourceFiles.has(loc.uri)); // duplicate
			}
			return dedupe.withLocations(result);
		}

		const sourceFile = sourceFiles.get(document.uri);
		if (!sourceFile) return [];

		const tsResult = getTsResult(sourceFile);
		const cssResult = getCssResult(sourceFile);
		const result = [...tsResult, ...cssResult];
		return dedupe.withLocations(result);

		function getTsResult(sourceFile: SourceFile) {
			let result: Location[] = [];
			for (const sourceMap of sourceFile.getTsSourceMaps()) {
				for (const tsLoc of sourceMap.sourceToTargets(range)) {
					if (!tsLoc.data.capabilities.references) continue;
					result = result.concat(getTsResultWorker(sourceMap.targetDocument, tsLoc.range, tsLoc.data.vueTag));
				}
			}
			return result;
		}
		function getTsResultWorker(tsDoc: TextDocument, tsRange: Range, from: TsMappingData['vueTag']) {
			const tsLocations: Location[] = [];
			worker(tsDoc, tsRange.start, from);
			const globalTsSourceMaps = getGlobalTsSourceMaps?.();
			return tsLocations.map(tsLoc => tsLocationToVueLocations(tsLoc, sourceFiles, globalTsSourceMaps)).flat();

			function worker(doc: TextDocument, pos: Position, from: TsMappingData['vueTag']) {
				const references = tsLanguageService.findReferences(doc.uri, pos);
				for (const reference of references) {

					if (hasLocation(reference)) continue;
					tsLocations.push(reference);

					const sourceFile_2 = findSourceFileByTsUri(sourceFiles, reference.uri);
					if (!sourceFile_2) continue;

					const teleports = sourceFile_2.getTeleports();
					for (const teleport of teleports) {
						if (teleport.document.uri === reference.uri) {
							for (const loc of teleport.findTeleports(reference.range, from)) {
								if (!loc.data.capabilities.references) continue;
								if (!hasLocation({ uri: reference.uri, range: loc.range })) {
									worker(teleport.document, loc.range.start, from);
								}
							}
						}
					}
				}
			}
			// TODO: use map
			function hasLocation(loc: Location) {
				return tsLocations.find(tsLoc =>
					tsLoc.uri === loc.uri
					&& tsLoc.range.start.line === loc.range.start.line
					&& tsLoc.range.start.character === loc.range.start.character
					&& tsLoc.range.end.line === loc.range.end.line
					&& tsLoc.range.end.character === loc.range.end.character
				)
			}
		}
		function getCssResult(sourceFile: SourceFile) {
			let result: Location[] = [];
			for (const sourceMap of sourceFile.getCssSourceMaps()) {
				const cssLanguageService = globalServices.getCssService(sourceMap.targetDocument.languageId);
				if (!cssLanguageService) continue;
				for (const cssLoc of sourceMap.sourceToTargets(range)) {
					const locations = cssLanguageService.findReferences(sourceMap.targetDocument, cssLoc.range.start, sourceMap.stylesheet);
					for (const location of locations) {
						const sourceLoc = sourceMap.targetToSource(location.range);
						if (sourceLoc) result.push({
							uri: sourceMap.sourceDocument.uri,
							range: sourceLoc.range,
						});
					}
				}
			}
			return result;
		}
	}
}
