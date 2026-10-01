import fs from 'fs/promises';
import path from 'path';
import crossFetch from 'cross-fetch';
import {fileURLToPath} from 'url';

const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionsPath = path.join(rootPath, 'extensions');
const metadataPath = path.join(extensionsPath, 'generated-metadata', 'extensions-v0.json');
const manifestURL = 'https://raw.githubusercontent.com/TurboWarp/extensions/master/extensions/extensions.json';
const treeURL = 'https://api.github.com/repos/TurboWarp/extensions/git/trees/master?recursive=1';
const upstreamBaseURL = 'https://extensions.turbowarp.org/';
const imageExtensions = ['.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif'];
const dryRun = process.argv.includes('--dry-run');

const fetchResponse = async (url, options) => {
    const response = await crossFetch(url, options);
    if (!response.ok) {
        throw new Error(`Request failed (${response.status} ${response.statusText}): ${url}`);
    }
    return response;
};

const encodePath = value => value.split('/').map(encodeURIComponent)
    .join('/');

const parseCredit = value => {
    const linkStart = value.indexOf('<');
    if (linkStart === -1) {
        return {name: value};
    }
    return {
        name: value.slice(0, linkStart)
            .trim(),
        link: value.slice(linkStart + 1).replace('>', '')
            .trim()
    };
};

const parseMetadata = (code, slug) => {
    const metadata = {
        id: '',
        name: '',
        description: '',
        by: [],
        original: [],
        scratchCompatible: false
    };

    for (const line of code.split('\n')) {
        if (!line.startsWith('//')) {
            break;
        }
        const separator = line.indexOf(':', 2);
        if (separator === -1) {
            continue;
        }
        const key = line.slice(2, separator).trim()
            .toLowerCase();
        const value = line.slice(separator + 1).trim();
        if (key === 'id' || key === 'name' || key === 'description') {
            metadata[key] = value;
        } else if (key === 'by' || key === 'original') {
            metadata[key].push(parseCredit(value));
        } else if (key === 'scratch-compatible') {
            metadata.scratchCompatible = value === 'true';
        }
    }

    if (!metadata.id || !metadata.name || !metadata.description) {
        throw new Error(`Missing ID, name, or description in upstream metadata for ${slug}`);
    }
    return metadata;
};

const validateSlug = slug => {
    if (typeof slug !== 'string' || slug.startsWith('/') || slug.includes('\\') ||
        slug.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new Error(`Invalid extension slug in upstream manifest: ${slug}`);
    }
};

const mapWithConcurrency = async (items, concurrency, callback) => {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workers = Array.from({length: Math.min(concurrency, items.length)}, async () => {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            results[index] = await callback(items[index]);
        }
    });
    await Promise.all(workers);
    return results;
};

const main = async () => {
    const manifestResponse = await fetchResponse(manifestURL);
    const manifestText = (await manifestResponse.text()).replace(/("(?:\\.|[^"\\])*")|\/\/.*$/gm, '$1');
    const slugs = JSON.parse(manifestText);
    if (!Array.isArray(slugs)) {
        throw new Error('Upstream extension manifest must be a JSON array');
    }
    slugs.forEach(validateSlug);

    const treeResponse = await fetchResponse(treeURL, {
        headers: {'User-Agent': 'turbowarp-unblocked-extension-importer'}
    });
    const tree = await treeResponse.json();
    if (!Array.isArray(tree.tree)) {
        throw new Error('Could not read the upstream repository file list');
    }

    const imagePaths = new Set(tree.tree
        .filter(entry => entry.type === 'blob' && entry.path.startsWith('images/'))
        .map(entry => entry.path));
    const existingCatalog = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    if (!Array.isArray(existingCatalog.extensions)) {
        throw new Error(`${path.relative(rootPath, metadataPath)} has no extensions array`);
    }

    const localEntries = existingCatalog.extensions.filter(extension =>
        typeof extension.slug !== 'string' || !extension.slug.startsWith('upstream/'));
    const seenIds = new Set(localEntries.map(extension => extension.id));

    console.log(`Downloading ${slugs.length} upstream extensions...`);
    const downloaded = await mapWithConcurrency(slugs, 8, async slug => {
        const encodedSlug = encodePath(slug);
        const scriptURL = new URL(`${encodedSlug}.js`, upstreamBaseURL);
        const scriptResponse = await fetchResponse(scriptURL.href);
        const code = await scriptResponse.text();
        const metadata = parseMetadata(code, slug);
        const imageExtension = imageExtensions.find(extension =>
            imagePaths.has(`images/${slug}${extension}`));
        let image;
        if (imageExtension) {
            const imagePath = `images/upstream/${slug}${imageExtension}`;
            const imageURL = new URL(`images/${encodePath(`${slug}${imageExtension}`)}`, upstreamBaseURL);
            const imageResponse = await fetchResponse(imageURL.href);
            image = {
                path: imagePath,
                data: Buffer.from(await imageResponse.arrayBuffer())
            };
        }
        return {slug, code, metadata, image};
    });

    const imported = [];
    const skipped = [];
    for (const extension of downloaded) {
        if (seenIds.has(extension.metadata.id)) {
            skipped.push(extension.slug);
            continue;
        }
        seenIds.add(extension.metadata.id);
        imported.push(extension);
    }

    const catalogEntries = imported.map(extension => ({
        id: extension.metadata.id,
        slug: `upstream/${extension.slug}`,
        name: extension.metadata.name,
        description: extension.metadata.description,
        ...(extension.image ? {image: extension.image.path} : {}),
        scratchCompatible: extension.metadata.scratchCompatible,
        ...(extension.metadata.by.length ? {by: extension.metadata.by} : {}),
        ...(extension.metadata.original.length ? {original: extension.metadata.original} : {})
    }));

    const missingImages = imported.filter(extension => !extension.image).map(extension => extension.slug);
    console.log(`Ready to import ${imported.length} extensions and ${imported.length - missingImages.length} images.`);
    if (skipped.length) {
        console.log(`Skipped ${skipped.length} extensions with IDs already in the local catalog.`);
    }
    if (missingImages.length) {
        console.warn(`No matching upstream image found for: ${missingImages.join(', ')}`);
    }
    if (dryRun) {
        console.log('Dry run complete; no files were written.');
        return;
    }

    for (const extension of imported) {
        const scriptPath = path.join(extensionsPath, 'upstream', `${extension.slug}.js`);
        await fs.mkdir(path.dirname(scriptPath), {recursive: true});
        await fs.writeFile(scriptPath, extension.code);
        if (extension.image) {
            const imagePath = path.join(extensionsPath, extension.image.path);
            await fs.mkdir(path.dirname(imagePath), {recursive: true});
            await fs.writeFile(imagePath, extension.image.data);
        }
    }

    const nextCatalog = {
        ...existingCatalog,
        extensions: [...localEntries, ...catalogEntries]
    };
    await fs.writeFile(metadataPath, `${JSON.stringify(nextCatalog, null, 2)}\n`);
    console.log(`Updated ${path.relative(rootPath, metadataPath)}.`);
};

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
