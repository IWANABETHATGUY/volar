import {
	Position,
	TextDocument,
	Location,
	Range,
} from 'vscode-languageserver/node';
import {
	findSourceFileByTsUri,
	tsLocationToVueLocations,
} from '../utils/commons';
import { SourceFile } from '../sourceFiles';
import { TsMappingData, TsSourceMap } from '../utils/sourceMaps';
import * as globalServices from '../globalServices';
import type * as ts2 from '@volar/vscode-typescript-languageservice';
import * as dedupe from '../utils/dedupe';

export function register(sourceFiles: Map<string, SourceFile>, tsLanguageService: ts2.LanguageService, getGlobalTsSourceMaps?: () => Map<string, { sourceMap: TsSourceMap }>) {
	return (document: TextDocument, position: Position, ingoreTsResult = false) => {

		if (document.languageId !== 'vue') {
			const tsLocs = tsLanguageService.findDefinition(document.uri, position);
			let result = tsLocs.map(tsLoc => tsLocationToVueLocations(tsLoc, sourceFiles)).flat();
			if (ingoreTsResult) {
				result = result.filter(loc => sourceFiles.has(loc.uri)); // duplicate
			}
			return result;
		}

		const sourceFile = sourceFiles.get(document.uri);
		if (!sourceFile) return [];
		const tsResult = tsDefinitionWorker(sourceFile, position, sourceFiles, tsLanguageService.findDefinition, getGlobalTsSourceMaps?.());
		const cssResult = getCssResult(sourceFile);

		const result = [...tsResult, ...cssResult];
		return dedupe.withLocations(result);

		function getCssResult(sourceFile: SourceFile) {
			let result: Location[] = [];
			const sourceMaps = sourceFile.getCssSourceMaps();
			for (const sourceMap of sourceMaps) {
				const cssLanguageService = globalServices.getCssService(sourceMap.targetDocument.languageId);
				if (!cssLanguageService) continue;
				const cssLocs = sourceMap.sourceToTargets(Range.create(position, position));
				for (const virLoc of cssLocs) {
					const definition = cssLanguageService.findDefinition(sourceMap.targetDocument, virLoc.range.start, sourceMap.stylesheet);
					if (definition) {
						const vueLocs = tsLocationToVueLocations(definition, sourceFiles);
						result = result.concat(vueLocs);
					}
				}
			}
			return result;
		}
	}
}

export function tsDefinitionWorker(sourceFile: SourceFile, position: Position, sourceFiles: Map<string, SourceFile>, _worker: (uri: string, position: Position) => Location[], globalTsSourceMaps?: Map<string, { sourceMap: TsSourceMap }>) {
	const tsLocs: Location[] = [];
	const range = {
		start: position,
		end: position,
	};
	let result: Location[] = [];

	for (const sourceMap of sourceFile.getTsSourceMaps()) {
		for (const tsLoc of sourceMap.sourceToTargets(range)) {
			if (!tsLoc.data.capabilities.definitions) continue;
			worker(sourceMap.targetDocument, tsLoc.range.start, tsLoc.data.vueTag);
		}
	}

	return result.map(r => tsLocationToVueLocations(r, sourceFiles, globalTsSourceMaps)).flat();

	function worker(doc: TextDocument, pos: Position, from: TsMappingData['vueTag']) {
		const references = _worker(doc.uri, pos);
		for (const reference of references) {

			if (hasLocation(reference)) continue;
			tsLocs.push(reference);

			const sourceFile_2 = findSourceFileByTsUri(sourceFiles, reference.uri);
			if (sourceFile_2) {
				const teleports = sourceFile_2.getTeleports();
				for (const teleport of teleports) {
					if (teleport.document.uri === reference.uri) {
						for (const loc of teleport.findTeleports(reference.range, from)) {
							if (!loc.data.capabilities.definitions) continue;
							if (!hasLocation({ uri: reference.uri, range: loc.range })) {
								worker(teleport.document, loc.range.start, from);
							}
						}
					}
				}
			}

			result.push(reference);
		}
	}
	function hasLocation(loc: Location) {
		return tsLocs.find(tsLoc =>
			tsLoc.uri === loc.uri
			&& tsLoc.range.start.line === loc.range.start.line
			&& tsLoc.range.start.character === loc.range.start.character
			&& tsLoc.range.end.line === loc.range.end.line
			&& tsLoc.range.end.character === loc.range.end.character
		)
	}
}
