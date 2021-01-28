import type { HtmlApiRegisterOptions } from '../types';
import type { Position } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import * as globalServices from '../globalServices';

export function register({ getHtmlDocument }: HtmlApiRegisterOptions) {
	return (document: TextDocument, position: Position): string | undefined | null => {
		return globalServices.html.doTagComplete(document, position, getHtmlDocument(document));
	}
}
