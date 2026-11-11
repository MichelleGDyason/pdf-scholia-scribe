export type ZoteroAttachmentMatchConfidence = 'exact' | 'review';

export type ZoteroAttachmentIdentity = {
	path: string;
	filename: string;
	title: string;
};

export type ZoteroAttachmentMatch<T> = {
	attachment: T;
	confidence: ZoteroAttachmentMatchConfidence;
};

function normalizedPath(value: string): string {
	return decodedLinkedPath(value)
		.normalize('NFKC')
		.replace(/\\/g, '/')
		.replace(/\/+$/g, '')
		.toLocaleLowerCase();
}

function decodedLinkedPath(value: string): string {
	if (!/^file:/i.test(value)) return value;

	try {
		const url = new URL(value);
		let path = decodeURIComponent(url.pathname);
		if (url.hostname && url.hostname.toLocaleLowerCase() !== 'localhost') {
			path = `//${url.hostname}${path}`;
		} else if (/^\/[a-z]:\//i.test(path)) {
			path = path.slice(1);
		}
		return path;
	} catch {
		const path = value.replace(/^file:(?:\/\/)?/i, '');
		try {
			return decodeURIComponent(path);
		} catch {
			return path;
		}
	}
}

function attachmentFilename(attachment: ZoteroAttachmentIdentity): string {
	const storedPath = /^storage:/i.test(attachment.path)
		? attachment.path.replace(/^storage:/i, '')
		: decodedLinkedPath(attachment.path);
	return (attachment.filename || storedPath.split(/[\\/]/).pop() || attachment.title).trim();
}

/**
 * Prefer an exact linked-file path. A unique filename-only match remains
 * reviewable because copied Zotero storage files and generic PDF names can be
 * ambiguous.
 */
export function chooseZoteroAttachmentMatch<T extends ZoteroAttachmentIdentity>(
	attachments: T[],
	expectedFilename: string,
	expectedFullPath: string,
): ZoteroAttachmentMatch<T> | null {
	const normalizedExpectedPath = normalizedPath(expectedFullPath);
	if (normalizedExpectedPath) {
		const pathMatches = attachments.filter((attachment) => {
			if (!attachment.path || /^storage:/i.test(attachment.path)) return false;
			return normalizedPath(attachment.path) === normalizedExpectedPath;
		});
		if (pathMatches.length === 1) return { attachment: pathMatches[0], confidence: 'exact' };
		if (pathMatches.length > 1) return null;
	}

	const normalizedExpectedFilename = expectedFilename.normalize('NFKC').toLocaleLowerCase();
	const filenameMatches = attachments.filter((attachment) => {
		return attachmentFilename(attachment).normalize('NFKC').toLocaleLowerCase() === normalizedExpectedFilename;
	});
	return filenameMatches.length === 1
		? { attachment: filenameMatches[0], confidence: 'review' }
		: null;
}
