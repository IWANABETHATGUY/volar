import {
	Diagnostic,
	DiagnosticTag,
	DiagnosticSeverity,
} from 'vscode-languageserver/node';
import { uriToFsPath } from '@volar/shared';
import type * as ts from 'typescript';
import { getTypescript } from '@volar/vscode-builtin-packages';
import type { TextDocument } from 'vscode-languageserver-textdocument';

export function register(languageService: ts.LanguageService, getTextDocument: (uri: string) => TextDocument | undefined) {
	const ts = getTypescript();
	return (
		uri: string,
		options: { semantic?: boolean, syntactic?: boolean, suggestion?: boolean } = { semantic: true, syntactic: true, suggestion: true },
		cancellationToken?: ts.CancellationToken,
	): Diagnostic[] => {
		const document = getTextDocument(uri);
		if (!document) return [];

		const fileName = uriToFsPath(document.uri);
		const program = languageService.getProgram();
		const sourceFile = program?.getSourceFile(fileName);
		if (!program || !sourceFile) return [];

		let errors: ts.Diagnostic[] = [];

		try {
			errors = [
				...options.semantic ? program.getSemanticDiagnostics(sourceFile, cancellationToken) : [],
				...options.syntactic ? program.getSyntacticDiagnostics(sourceFile, cancellationToken) : [],
				...options.suggestion ? languageService.getSuggestionDiagnostics(fileName) : [],
			];
		}
		catch { }

		return translateDiagnostics(document, errors);

		function translateDiagnostics(document: TextDocument, input: readonly ts.Diagnostic[]) {
			let output: Diagnostic[] = [];

			for (const diag of input) {
				if (diag.start === undefined) continue;
				if (diag.length === undefined) continue;

				const diagnostic: Diagnostic = {
					range: {
						start: document.positionAt(diag.start),
						end: document.positionAt(diag.start + diag.length),
					},
					severity: translateErrorType(diag.category),
					source: 'ts',
					code: diag.code,
					message: typeof diag.messageText === 'string' ? diag.messageText : diag.messageText.messageText,
				};

				if (diag.reportsUnnecessary) {
					if (diagnostic.tags === undefined) diagnostic.tags = [];
					diagnostic.tags.push(DiagnosticTag.Unnecessary);
				}
				if (diag.reportsDeprecated) {
					if (diagnostic.tags === undefined) diagnostic.tags = [];
					diagnostic.tags.push(DiagnosticTag.Deprecated);
				}

				output.push(diagnostic);
			}

			return output;
		}
		function translateErrorType(input: ts.DiagnosticCategory): DiagnosticSeverity {
			switch (input) {
				case ts.DiagnosticCategory.Warning: return DiagnosticSeverity.Warning;
				case ts.DiagnosticCategory.Error: return DiagnosticSeverity.Error;
				case ts.DiagnosticCategory.Suggestion: return DiagnosticSeverity.Hint;
				case ts.DiagnosticCategory.Message: return DiagnosticSeverity.Information;
			}
		}
	};
}
