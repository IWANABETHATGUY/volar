import {
	Position,
	Range,
	Location,
} from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { SourceFile } from '../sourceFiles';
import type { TsMappingData, TsSourceMap } from '../utils/sourceMaps';

export function tsLocationToVueLocations(location: Location, sourceFiles: Map<string, SourceFile>, globalTsSourceMaps?: Map<string, { sourceMap: TsSourceMap }>): Location[] {
	return tsLocationToVueLocationsRaw(location, sourceFiles, globalTsSourceMaps).map(loc => loc[0]);
}
export function tsLocationToVueLocationsRaw(location: Location, sourceFiles: Map<string, SourceFile>, globalTsSourceMaps?: Map<string, { sourceMap: TsSourceMap }>): [Location, TsMappingData | undefined][] {
	// patch global components call
	const globalTs = globalTsSourceMaps?.get(location.uri);
	if (globalTs) {
		const tsLoc2 = globalTs.sourceMap.targetToSource(location.range);
		if (tsLoc2) {
			location.range = tsLoc2.range;
		}
	}

	const sourceFile = findSourceFileByTsUri(sourceFiles, location.uri);
	if (!sourceFile)
		return [[location, undefined]]; // not virtual ts script

	const result: [Location, TsMappingData][] = [];

	for (const sourceMap of sourceFile.getTsSourceMaps()) {
		if (sourceMap.targetDocument.uri !== location.uri) continue;
		const vueLocs = sourceMap.targetToSources(location.range);
		for (const vueLoc of vueLocs) {
			const sourceLocation = Location.create(sourceMap.sourceDocument.uri, vueLoc.range)
			result.push([sourceLocation, vueLoc.data]);
		}
	}

	return result;
}
export function findSourceFileByTsUri(sourceFiles: Map<string, SourceFile>, uri: string) {
	for (const sourceFile of sourceFiles.values()) {
		if (sourceFile.getTsDocuments().has(uri)) {
			return sourceFile;
		}
	}
	return undefined;
}
export function isStartWithText(document: TextDocument, position: Position, text: string) {
	return document.getText(Range.create(document.positionAt(document.offsetAt(position) - text.length), position)) === text;
}
