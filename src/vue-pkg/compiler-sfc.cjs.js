'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

var CompilerDOM = require('./compiler-dom.cjs');
var sourceMap = require('source-map');
var path = require('path');
var compilerCore = require('./compiler-core.cjs');
var url = require('url');
var shared = require('@vue/shared');
var CompilerSSR = require('@vue/compiler-ssr');
var postcss = require('postcss');
var selectorParser = require('postcss-selector-parser');
var merge = require('merge-source-map');
var MagicString = require('magic-string');
var parser = require('@babel/parser');
var estreeWalker = require('estree-walker');

function _interopDefaultLegacy (e) { return e && typeof e === 'object' && 'default' in e ? e['default'] : e; }

function _interopNamespace(e) {
  if (e && e.__esModule) { return e; } else {
    var n = Object.create(null);
    if (e) {
      Object.keys(e).forEach(function (k) {
        n[k] = e[k];
      });
    }
    n['default'] = e;
    return Object.freeze(n);
  }
}

var CompilerDOM__namespace = /*#__PURE__*/_interopNamespace(CompilerDOM);
var path__default = /*#__PURE__*/_interopDefaultLegacy(path);
var CompilerSSR__namespace = /*#__PURE__*/_interopNamespace(CompilerSSR);
var postcss__default = /*#__PURE__*/_interopDefaultLegacy(postcss);
var selectorParser__default = /*#__PURE__*/_interopDefaultLegacy(selectorParser);
var merge__default = /*#__PURE__*/_interopDefaultLegacy(merge);
var MagicString__default = /*#__PURE__*/_interopDefaultLegacy(MagicString);

const SFC_CACHE_MAX_SIZE = 500;
const sourceToSFC =  new (require('lru-cache'))(SFC_CACHE_MAX_SIZE);
function parse(source, { sourceMap = true, filename = 'component.vue', sourceRoot = '', pad = false, compiler = CompilerDOM__namespace } = {}) {
    const sourceKey = source + sourceMap + filename + sourceRoot + pad + compiler.parse;
    const cache = sourceToSFC.get(sourceKey);
    if (cache) {
        return cache;
    }
    const descriptor = {
        filename,
        source,
        templates: [],
        script: null,
        scriptSetup: null,
        styles: [],
        customBlocks: []
    };
    const errors = [];
    const ast = compiler.parse(source, {
        // there are no components at SFC parsing level
        isNativeTag: () => true,
        // preserve all whitespaces
        isPreTag: () => true,
        getTextMode: ({ tag, props }, parent) => {
            // all top level elements except <template> are parsed as raw text
            // containers
            if ((!parent && tag !== 'template') ||
                // <template lang="xxx"> should also be treated as raw text
                props.some(p => p.type === 6 /* ATTRIBUTE */ &&
                    p.name === 'lang' &&
                    p.value &&
                    p.value.content !== 'html')) {
                return 2 /* RAWTEXT */;
            }
            else {
                return 0 /* DATA */;
            }
        },
        onError: e => {
            errors.push(e);
        }
    });
    ast.children.forEach(node => {
        if (node.type !== 1 /* ELEMENT */) {
            return;
        }
        if (!node.children.length && !hasSrc(node)) {
            return;
        }
        switch (node.tag) {
            case 'template':
                descriptor.templates.push(createBlock(node, source, false));
                // if (!descriptor.template) {
                //   descriptor.template = createBlock(
                //     node,
                //     source,
                //     false
                //   ) as SFCTemplateBlock
                // } else {
                //   errors.push(createDuplicateBlockError(node))
                // }
                break;
            case 'script':
                const block = createBlock(node, source, pad);
                const isSetup = !!block.attrs.setup;
                if (isSetup && !descriptor.scriptSetup) {
                    descriptor.scriptSetup = block;
                    break;
                }
                if (!isSetup && !descriptor.script) {
                    descriptor.script = block;
                    break;
                }
                errors.push(createDuplicateBlockError(node, isSetup));
                break;
            case 'style':
                descriptor.styles.push(createBlock(node, source, pad));
                break;
            default:
                descriptor.customBlocks.push(createBlock(node, source, pad));
                break;
        }
    });
    if (descriptor.scriptSetup) {
        if (descriptor.scriptSetup.src) {
            errors.push(new SyntaxError(`<script setup> cannot use the "src" attribute because ` +
                `its syntax will be ambiguous outside of the component.`));
            descriptor.scriptSetup = null;
        }
        if (descriptor.script && descriptor.script.src) {
            errors.push(new SyntaxError(`<script> cannot use the "src" attribute when <script setup> is ` +
                `also present because they must be processed together.`));
            descriptor.script = null;
        }
    }
    if (sourceMap) {
        const genMap = (block) => {
            if (block && !block.src) {
                block.map = generateSourceMap(filename, source, block.content, sourceRoot, !pad || block.type === 'template' ? block.loc.start.line - 1 : 0);
            }
        };
        // genMap(descriptor.template)
        descriptor.templates.forEach(genMap);
        genMap(descriptor.script);
        descriptor.styles.forEach(genMap);
        descriptor.customBlocks.forEach(genMap);
    }
    const result = {
        ast,
        descriptor,
        errors
    };
    sourceToSFC.set(sourceKey, result);
    return result;
}
function createDuplicateBlockError(node, isScriptSetup = false) {
    const err = new SyntaxError(`Single file component can contain only one <${node.tag}${isScriptSetup ? ` setup` : ``}> element`);
    err.loc = node.loc;
    return err;
}
function createBlock(node, source, pad) {
    const type = node.tag;
    let { start, end } = node.loc;
    let content = '';
    if (node.children.length) {
        start = node.children[0].loc.start;
        end = node.children[node.children.length - 1].loc.end;
        content = source.slice(start.offset, end.offset);
    }
    const loc = {
        source: content,
        start,
        end
    };
    const attrs = {};
    const block = {
        type,
        content,
        loc,
        attrs
    };
    if (pad) {
        block.content = padContent(source, block, pad) + block.content;
    }
    node.props.forEach(p => {
        if (p.type === 6 /* ATTRIBUTE */) {
            attrs[p.name] = p.value ? p.value.content || true : true;
            if (p.name === 'lang') {
                block.lang = p.value && p.value.content;
            }
            else if (p.name === 'src') {
                block.src = p.value && p.value.content;
            }
            else if (type === 'style') {
                if (p.name === 'scoped') {
                    block.scoped = true;
                }
                else if (p.name === 'vars' && typeof attrs.vars === 'string') {
                    block.vars = attrs.vars;
                }
                else if (p.name === 'module') {
                    block.module = attrs[p.name];
                }
            }
            else if (type === 'template' && p.name === 'functional') {
                block.functional = true;
            }
            else if (type === 'script' && p.name === 'setup') {
                block.setup = attrs.setup;
            }
        }
    });
    return block;
}
const splitRE = /\r?\n/g;
const emptyRE = /^(?:\/\/)?\s*$/;
const replaceRE = /./g;
function generateSourceMap(filename, source, generated, sourceRoot, lineOffset) {
    const map = new sourceMap.SourceMapGenerator({
        file: filename.replace(/\\/g, '/'),
        sourceRoot: sourceRoot.replace(/\\/g, '/')
    });
    map.setSourceContent(filename, source);
    generated.split(splitRE).forEach((line, index) => {
        if (!emptyRE.test(line)) {
            const originalLine = index + 1 + lineOffset;
            const generatedLine = index + 1;
            for (let i = 0; i < line.length; i++) {
                if (!/\s/.test(line[i])) {
                    map.addMapping({
                        source: filename,
                        original: {
                            line: originalLine,
                            column: i
                        },
                        generated: {
                            line: generatedLine,
                            column: i
                        }
                    });
                }
            }
        }
    });
    return JSON.parse(map.toString());
}
function padContent(content, block, pad) {
    content = content.slice(0, block.loc.start.offset);
    if (pad === 'space') {
        return content.replace(replaceRE, ' ');
    }
    else {
        const offset = content.split(splitRE).length;
        const padChar = block.type === 'script' && !block.lang ? '//\n' : '\n';
        return Array(offset).join(padChar);
    }
}
function hasSrc(node) {
    return node.props.some(p => {
        if (p.type !== 6 /* ATTRIBUTE */) {
            return false;
        }
        return p.name === 'src';
    });
}

function isRelativeUrl(url) {
    const firstChar = url.charAt(0);
    return firstChar === '.' || firstChar === '~' || firstChar === '@';
}
const externalRE = /^https?:\/\//;
function isExternalUrl(url) {
    return externalRE.test(url);
}
const dataUrlRE = /^\s*data:/i;
function isDataUrl(url) {
    return dataUrlRE.test(url);
}
/**
 * Parses string url into URL object.
 */
function parseUrl(url) {
    const firstChar = url.charAt(0);
    if (firstChar === '~') {
        const secondChar = url.charAt(1);
        url = url.slice(secondChar === '/' ? 2 : 1);
    }
    return parseUriParts(url);
}
/**
 * vuejs/component-compiler-utils#22 Support uri fragment in transformed require
 * @param urlString an url as a string
 */
function parseUriParts(urlString) {
    // A TypeError is thrown if urlString is not a string
    // @see https://nodejs.org/api/url.html#url_url_parse_urlstring_parsequerystring_slashesdenotehost
    return url.parse(shared.isString(urlString) ? urlString : '');
}

const defaultAssetUrlOptions = {
    base: null,
    includeAbsolute: false,
    tags: {
        video: ['src', 'poster'],
        source: ['src'],
        img: ['src'],
        image: ['xlink:href', 'href'],
        use: ['xlink:href', 'href']
    }
};
const normalizeOptions = (options) => {
    if (Object.keys(options).some(key => shared.isArray(options[key]))) {
        // legacy option format which directly passes in tags config
        return {
            ...defaultAssetUrlOptions,
            tags: options
        };
    }
    return {
        ...defaultAssetUrlOptions,
        ...options
    };
};
const createAssetUrlTransformWithOptions = (options) => {
    return (node, context) => transformAssetUrl(node, context, options);
};
/**
 * A `@vue/compiler-core` plugin that transforms relative asset urls into
 * either imports or absolute urls.
 *
 * ``` js
 * // Before
 * createVNode('img', { src: './logo.png' })
 *
 * // After
 * import _imports_0 from './logo.png'
 * createVNode('img', { src: _imports_0 })
 * ```
 */
const transformAssetUrl = (node, context, options = defaultAssetUrlOptions) => {
    if (node.type === 1 /* ELEMENT */) {
        if (!node.props.length) {
            return;
        }
        const tags = options.tags || defaultAssetUrlOptions.tags;
        const attrs = tags[node.tag];
        const wildCardAttrs = tags['*'];
        if (!attrs && !wildCardAttrs) {
            return;
        }
        const assetAttrs = (attrs || []).concat(wildCardAttrs || []);
        node.props.forEach((attr, index) => {
            if (attr.type !== 6 /* ATTRIBUTE */ ||
                !assetAttrs.includes(attr.name) ||
                !attr.value ||
                isExternalUrl(attr.value.content) ||
                isDataUrl(attr.value.content) ||
                attr.value.content[0] === '#' ||
                (!options.includeAbsolute && !isRelativeUrl(attr.value.content))) {
                return;
            }
            const url = parseUrl(attr.value.content);
            if (options.base) {
                // explicit base - directly rewrite the url into absolute url
                // does not apply to absolute urls or urls that start with `@`
                // since they are aliases
                if (attr.value.content[0] !== '@' &&
                    isRelativeUrl(attr.value.content)) {
                    // when packaged in the browser, path will be using the posix-
                    // only version provided by rollup-plugin-node-builtins.
                    attr.value.content = (path__default.posix || path__default).join(options.base, url.path + (url.hash || ''));
                }
                return;
            }
            // otherwise, transform the url into an import.
            // this assumes a bundler will resolve the import into the correct
            // absolute url (e.g. webpack file-loader)
            const exp = getImportsExpressionExp(url.path, url.hash, attr.loc, context);
            node.props[index] = {
                type: 7 /* DIRECTIVE */,
                name: 'bind',
                arg: compilerCore.createSimpleExpression(attr.name, true, attr.loc),
                exp,
                modifiers: [],
                loc: attr.loc
            };
        });
    }
};
function getImportsExpressionExp(path, hash, loc, context) {
    if (path) {
        const importsArray = Array.from(context.imports);
        const existing = importsArray.find(i => i.path === path);
        if (existing) {
            return existing.exp;
        }
        const name = `_imports_${importsArray.length}`;
        const exp = compilerCore.createSimpleExpression(name, false, loc, true);
        exp.isRuntimeConstant = true;
        context.imports.add({ exp, path });
        if (hash && path) {
            const ret = context.hoist(compilerCore.createSimpleExpression(`${name} + '${hash}'`, false, loc, true));
            ret.isRuntimeConstant = true;
            return ret;
        }
        else {
            return exp;
        }
    }
    else {
        return compilerCore.createSimpleExpression(`''`, false, loc, true);
    }
}

const srcsetTags = ['img', 'source'];
// http://w3c.github.io/html/semantics-embedded-content.html#ref-for-image-candidate-string-5
const escapedSpaceCharacters = /( |\\t|\\n|\\f|\\r)+/g;
const createSrcsetTransformWithOptions = (options) => {
    return (node, context) => transformSrcset(node, context, options);
};
const transformSrcset = (node, context, options = defaultAssetUrlOptions) => {
    if (node.type === 1 /* ELEMENT */) {
        if (srcsetTags.includes(node.tag) && node.props.length) {
            node.props.forEach((attr, index) => {
                if (attr.name === 'srcset' && attr.type === 6 /* ATTRIBUTE */) {
                    if (!attr.value)
                        return;
                    const value = attr.value.content;
                    const imageCandidates = value.split(',').map(s => {
                        // The attribute value arrives here with all whitespace, except
                        // normal spaces, represented by escape sequences
                        const [url, descriptor] = s
                            .replace(escapedSpaceCharacters, ' ')
                            .trim()
                            .split(' ', 2);
                        return { url, descriptor };
                    });
                    // for data url need recheck url
                    for (let i = 0; i < imageCandidates.length; i++) {
                        if (imageCandidates[i].url.trim().startsWith('data:')) {
                            imageCandidates[i + 1].url =
                                imageCandidates[i].url + ',' + imageCandidates[i + 1].url;
                            imageCandidates.splice(i, 1);
                        }
                    }
                    // When srcset does not contain any relative URLs, skip transforming
                    if (!options.includeAbsolute &&
                        !imageCandidates.some(({ url }) => isRelativeUrl(url))) {
                        return;
                    }
                    if (options.base) {
                        const base = options.base;
                        const set = [];
                        imageCandidates.forEach(({ url, descriptor }) => {
                            descriptor = descriptor ? ` ${descriptor}` : ``;
                            if (isRelativeUrl(url)) {
                                set.push((path__default.posix || path__default).join(base, url) + descriptor);
                            }
                            else {
                                set.push(url + descriptor);
                            }
                        });
                        attr.value.content = set.join(', ');
                        return;
                    }
                    const compoundExpression = compilerCore.createCompoundExpression([], attr.loc);
                    imageCandidates.forEach(({ url, descriptor }, index) => {
                        if (!isExternalUrl(url) &&
                            !isDataUrl(url) &&
                            (options.includeAbsolute || isRelativeUrl(url))) {
                            const { path } = parseUrl(url);
                            let exp;
                            if (path) {
                                const importsArray = Array.from(context.imports);
                                const existingImportsIndex = importsArray.findIndex(i => i.path === path);
                                if (existingImportsIndex > -1) {
                                    exp = compilerCore.createSimpleExpression(`_imports_${existingImportsIndex}`, false, attr.loc, true);
                                }
                                else {
                                    exp = compilerCore.createSimpleExpression(`_imports_${importsArray.length}`, false, attr.loc, true);
                                    context.imports.add({ exp, path });
                                }
                                compoundExpression.children.push(exp);
                            }
                        }
                        else {
                            const exp = compilerCore.createSimpleExpression(`"${url}"`, false, attr.loc, true);
                            compoundExpression.children.push(exp);
                        }
                        const isNotLast = imageCandidates.length - 1 > index;
                        if (descriptor && isNotLast) {
                            compoundExpression.children.push(` + '${descriptor}, ' + `);
                        }
                        else if (descriptor) {
                            compoundExpression.children.push(` + '${descriptor}'`);
                        }
                        else if (isNotLast) {
                            compoundExpression.children.push(` + ', ' + `);
                        }
                    });
                    const hoisted = context.hoist(compoundExpression);
                    hoisted.isRuntimeConstant = true;
                    node.props[index] = {
                        type: 7 /* DIRECTIVE */,
                        name: 'bind',
                        arg: compilerCore.createSimpleExpression('srcset', true, attr.loc),
                        exp: hoisted,
                        modifiers: [],
                        loc: attr.loc
                    };
                }
            });
        }
    }
};

function preprocess({ source, filename, preprocessOptions }, preprocessor) {
    // Consolidate exposes a callback based API, but the callback is in fact
    // called synchronously for most templating engines. In our case, we have to
    // expose a synchronous API so that it is usable in Jest transforms (which
    // have to be sync because they are applied via Node.js require hooks)
    let res = '';
    let err = null;
    preprocessor.render(source, { filename, ...preprocessOptions }, (_err, _res) => {
        if (_err)
            err = _err;
        res = _res;
    });
    if (err)
        throw err;
    return res;
}
function compileTemplate(options) {
    const { preprocessLang, preprocessCustomRequire } = options;
    const preprocessor = preprocessLang
        ? preprocessCustomRequire
            ? preprocessCustomRequire(preprocessLang)
            : require('consolidate')[preprocessLang]
        : false;
    if (preprocessor) {
        try {
            return doCompileTemplate({
                ...options,
                source: preprocess(options, preprocessor)
            });
        }
        catch (e) {
            return {
                code: `export default function render() {}`,
                source: options.source,
                tips: [],
                errors: [e]
            };
        }
    }
    else if (preprocessLang) {
        return {
            code: `export default function render() {}`,
            source: options.source,
            tips: [
                `Component ${options.filename} uses lang ${preprocessLang} for template. Please install the language preprocessor.`
            ],
            errors: [
                `Component ${options.filename} uses lang ${preprocessLang} for template, however it is not installed.`
            ]
        };
    }
    else {
        return doCompileTemplate(options);
    }
}
function doCompileTemplate({ filename, inMap, source, ssr = false, compiler = ssr ? CompilerSSR__namespace : CompilerDOM__namespace, compilerOptions = {}, transformAssetUrls }) {
    const errors = [];
    let nodeTransforms = [];
    if (shared.isObject(transformAssetUrls)) {
        const assetOptions = normalizeOptions(transformAssetUrls);
        nodeTransforms = [
            createAssetUrlTransformWithOptions(assetOptions),
            createSrcsetTransformWithOptions(assetOptions)
        ];
    }
    else if (transformAssetUrls !== false) {
        nodeTransforms = [transformAssetUrl, transformSrcset];
    }
    let { code, map, ast } = compiler.compile(source, {
        mode: 'module',
        prefixIdentifiers: true,
        hoistStatic: true,
        cacheHandlers: true,
        ...compilerOptions,
        nodeTransforms: nodeTransforms.concat(compilerOptions.nodeTransforms || []),
        filename,
        sourceMap: true,
        onError: e => errors.push(e)
    });
    // inMap should be the map produced by ./parse.ts which is a simple line-only
    // mapping. If it is present, we need to adjust the final map and errors to
    // reflect the original line numbers.
    if (inMap) {
        if (map) {
            map = mapLines(inMap, map);
        }
        if (errors.length) {
            patchErrors(errors, source, inMap);
        }
    }
    return { code, source, errors, tips: [], map, ast };
}
function mapLines(oldMap, newMap) {
    if (!oldMap)
        return newMap;
    if (!newMap)
        return oldMap;
    const oldMapConsumer = new sourceMap.SourceMapConsumer(oldMap);
    const newMapConsumer = new sourceMap.SourceMapConsumer(newMap);
    const mergedMapGenerator = new sourceMap.SourceMapGenerator();
    newMapConsumer.eachMapping(m => {
        if (m.originalLine == null) {
            return;
        }
        const origPosInOldMap = oldMapConsumer.originalPositionFor({
            line: m.originalLine,
            column: m.originalColumn
        });
        if (origPosInOldMap.source == null) {
            return;
        }
        mergedMapGenerator.addMapping({
            generated: {
                line: m.generatedLine,
                column: m.generatedColumn
            },
            original: {
                line: origPosInOldMap.line,
                // use current column, since the oldMap produced by @vue/compiler-sfc
                // does not
                column: m.originalColumn
            },
            source: origPosInOldMap.source,
            name: origPosInOldMap.name
        });
    });
    // source-map's type definition is incomplete
    const generator = mergedMapGenerator;
    oldMapConsumer.sources.forEach((sourceFile) => {
        generator._sources.add(sourceFile);
        const sourceContent = oldMapConsumer.sourceContentFor(sourceFile);
        if (sourceContent != null) {
            mergedMapGenerator.setSourceContent(sourceFile, sourceContent);
        }
    });
    generator._sourceRoot = oldMap.sourceRoot;
    generator._file = oldMap.file;
    return generator.toJSON();
}
function patchErrors(errors, source, inMap) {
    const originalSource = inMap.sourcesContent[0];
    const offset = originalSource.indexOf(source);
    const lineOffset = originalSource.slice(0, offset).split(/\r?\n/).length - 1;
    errors.forEach(err => {
        if (err.loc) {
            err.loc.start.line += lineOffset;
            err.loc.start.offset += offset;
            if (err.loc.end !== err.loc.start) {
                err.loc.end.line += lineOffset;
                err.loc.end.offset += offset;
            }
        }
    });
}

var trimPlugin = postcss__default.plugin('trim', () => (css) => {
    css.walk(({ type, raws }) => {
        if (type === 'rule' || type === 'atrule') {
            if (raws.before)
                raws.before = '\n';
            if (raws.after)
                raws.after = '\n';
        }
    });
});

const animationNameRE = /^(-\w+-)?animation-name$/;
const animationRE = /^(-\w+-)?animation$/;
var scopedPlugin = postcss__default.plugin('vue-scoped', (id) => (root) => {
    const keyframes = Object.create(null);
    const shortId = id.replace(/^data-v-/, '');
    root.each(function rewriteSelectors(node) {
        if (node.type !== 'rule') {
            // handle media queries
            if (node.type === 'atrule') {
                if (node.name === 'media' || node.name === 'supports') {
                    node.each(rewriteSelectors);
                }
                else if (/-?keyframes$/.test(node.name)) {
                    // register keyframes
                    keyframes[node.params] = node.params = node.params + '-' + shortId;
                }
            }
            return;
        }
        node.selector = selectorParser__default(selectors => {
            function rewriteSelector(selector, slotted) {
                let node = null;
                let shouldInject = true;
                // find the last child node to insert attribute selector
                selector.each(n => {
                    // DEPRECATED ">>>" and "/deep/" combinator
                    if (n.type === 'combinator' &&
                        (n.value === '>>>' || n.value === '/deep/')) {
                        n.value = ' ';
                        n.spaces.before = n.spaces.after = '';
                        console.warn(`[@vue/compiler-sfc] the >>> and /deep/ combinators have ` +
                            `been deprecated. Use ::v-deep instead.`);
                        return false;
                    }
                    if (n.type === 'pseudo') {
                        const { value } = n;
                        // deep: inject [id] attribute at the node before the ::v-deep
                        // combinator.
                        if (value === ':deep' || value === '::v-deep') {
                            if (n.nodes.length) {
                                // .foo ::v-deep(.bar) -> .foo[xxxxxxx] .bar
                                // replace the current node with ::v-deep's inner selector
                                selector.insertAfter(n, n.nodes[0]);
                                // insert a space combinator before if it doesn't already have one
                                const prev = selector.at(selector.index(n) - 1);
                                if (!prev || !isSpaceCombinator(prev)) {
                                    selector.insertAfter(n, selectorParser__default.combinator({
                                        value: ' '
                                    }));
                                }
                                selector.removeChild(n);
                            }
                            else {
                                // DEPRECATED usage
                                // .foo ::v-deep .bar -> .foo[xxxxxxx] .bar
                                console.warn(`[@vue/compiler-sfc] ::v-deep usage as a combinator has ` +
                                    `been deprecated. Use ::v-deep(<inner-selector>) instead.`);
                                const prev = selector.at(selector.index(n) - 1);
                                if (prev && isSpaceCombinator(prev)) {
                                    selector.removeChild(prev);
                                }
                                selector.removeChild(n);
                            }
                            return false;
                        }
                        // slot: use selector inside `::v-slotted` and inject [id + '-s']
                        // instead.
                        // ::v-slotted(.foo) -> .foo[xxxxxxx-s]
                        if (value === ':slotted' || value === '::v-slotted') {
                            rewriteSelector(n.nodes[0], true /* slotted */);
                            selector.insertAfter(n, n.nodes[0]);
                            selector.removeChild(n);
                            // since slotted attribute already scopes the selector there's no
                            // need for the non-slot attribute.
                            shouldInject = false;
                            return false;
                        }
                        // global: replace with inner selector and do not inject [id].
                        // ::v-global(.foo) -> .foo
                        if (value === ':global' || value === '::v-global') {
                            selectors.insertAfter(selector, n.nodes[0]);
                            selectors.removeChild(selector);
                            return false;
                        }
                    }
                    if (n.type !== 'pseudo' && n.type !== 'combinator') {
                        node = n;
                    }
                });
                if (node) {
                    node.spaces.after = '';
                }
                else {
                    // For deep selectors & standalone pseudo selectors,
                    // the attribute selectors are prepended rather than appended.
                    // So all leading spaces must be eliminated to avoid problems.
                    selector.first.spaces.before = '';
                }
                if (shouldInject) {
                    const idToAdd = slotted ? id + '-s' : id;
                    selector.insertAfter(
                    // If node is null it means we need to inject [id] at the start
                    // insertAfter can handle `null` here
                    node, selectorParser__default.attribute({
                        attribute: idToAdd,
                        value: idToAdd,
                        raws: {},
                        quoteMark: `"`
                    }));
                }
            }
            selectors.each(selector => rewriteSelector(selector));
        }).processSync(node.selector);
    });
    if (Object.keys(keyframes).length) {
        // If keyframes are found in this <style>, find and rewrite animation names
        // in declarations.
        // Caveat: this only works for keyframes and animation rules in the same
        // <style> element.
        // individual animation-name declaration
        root.walkDecls(decl => {
            if (animationNameRE.test(decl.prop)) {
                decl.value = decl.value
                    .split(',')
                    .map(v => keyframes[v.trim()] || v.trim())
                    .join(',');
            }
            // shorthand
            if (animationRE.test(decl.prop)) {
                decl.value = decl.value
                    .split(',')
                    .map(v => {
                    const vals = v.trim().split(/\s+/);
                    const i = vals.findIndex(val => keyframes[val]);
                    if (i !== -1) {
                        vals.splice(i, 1, keyframes[vals[i]]);
                        return vals.join(' ');
                    }
                    else {
                        return v;
                    }
                })
                    .join(',');
            }
        });
    }
});
function isSpaceCombinator(node) {
    return node.type === 'combinator' && /^\s+$/.test(node.value);
}

const cssVarRE = /\bvar\(--(global:)?([^)]+)\)/g;
var scopedVarsPlugin = postcss__default.plugin('vue-scoped', (id) => (root) => {
    const shortId = id.replace(/^data-v-/, '');
    root.walkDecls(decl => {
        // rewrite CSS variables
        if (cssVarRE.test(decl.value)) {
            decl.value = decl.value.replace(cssVarRE, (_, $1, $2) => {
                return $1 ? `var(--${$2})` : `var(--${shortId}-${$2})`;
            });
        }
    });
});

// .scss/.sass processor
const scss = (source, map, options, load = require) => {
    const nodeSass = load('sass');
    const finalOptions = {
        ...options,
        data: getSource(source, options.filename, options.additionalData),
        file: options.filename,
        outFile: options.filename,
        sourceMap: !!map
    };
    try {
        const result = nodeSass.renderSync(finalOptions);
        const dependencies = result.stats.includedFiles;
        if (map) {
            return {
                code: result.css.toString(),
                map: merge__default(map, JSON.parse(result.map.toString())),
                errors: [],
                dependencies
            };
        }
        return { code: result.css.toString(), errors: [], dependencies };
    }
    catch (e) {
        return { code: '', errors: [e], dependencies: [] };
    }
};
const sass = (source, map, options, load) => scss(source, map, {
    ...options,
    indentedSyntax: true
}, load);
// .less
const less = (source, map, options, load = require) => {
    const nodeLess = load('less');
    let result;
    let error = null;
    nodeLess.render(getSource(source, options.filename, options.additionalData), { ...options, syncImport: true }, (err, output) => {
        error = err;
        result = output;
    });
    if (error)
        return { code: '', errors: [error], dependencies: [] };
    const dependencies = result.imports;
    if (map) {
        return {
            code: result.css.toString(),
            map: merge__default(map, result.map),
            errors: [],
            dependencies: dependencies
        };
    }
    return {
        code: result.css.toString(),
        errors: [],
        dependencies: dependencies
    };
};
// .styl
const styl = (source, map, options, load = require) => {
    const nodeStylus = load('stylus');
    try {
        const ref = nodeStylus(source);
        Object.keys(options).forEach(key => ref.set(key, options[key]));
        if (map)
            ref.set('sourcemap', { inline: false, comment: false });
        const result = ref.render();
        const dependencies = ref.deps();
        if (map) {
            return {
                code: result,
                map: merge__default(map, ref.sourcemap),
                errors: [],
                dependencies
            };
        }
        return { code: result, errors: [], dependencies };
    }
    catch (e) {
        return { code: '', errors: [e], dependencies: [] };
    }
};
function getSource(source, filename, additionalData) {
    if (!additionalData)
        return source;
    if (shared.isFunction(additionalData)) {
        return additionalData(source, filename);
    }
    return additionalData + source;
}
const processors = {
    less,
    sass,
    scss,
    styl,
    stylus: styl
};

function compileStyle(options) {
    return doCompileStyle({
        ...options,
        isAsync: false
    });
}
function compileStyleAsync(options) {
    return doCompileStyle({ ...options, isAsync: true });
}
function doCompileStyle(options) {
    const { filename, id, scoped = false, vars = false, trim = true, modules = false, modulesOptions = {}, preprocessLang, postcssOptions, postcssPlugins } = options;
    const preprocessor = preprocessLang && processors[preprocessLang];
    const preProcessedSource = preprocessor && preprocess$1(options, preprocessor);
    const map = preProcessedSource ? preProcessedSource.map : options.map;
    const source = preProcessedSource ? preProcessedSource.code : options.source;
    const plugins = (postcssPlugins || []).slice();
    if (vars && scoped) {
        // vars + scoped, only applies to raw source before other transforms
        // #1623
        plugins.unshift(scopedVarsPlugin(id));
    }
    if (trim) {
        plugins.push(trimPlugin());
    }
    if (scoped) {
        plugins.push(scopedPlugin(id));
    }
    let cssModules;
    if (modules) {
        if (!options.isAsync) {
            throw new Error('[@vue/compiler-sfc] `modules` option can only be used with compileStyleAsync().');
        }
        plugins.push(require('postcss-modules')({
            ...modulesOptions,
            getJSON: (_cssFileName, json) => {
                cssModules = json;
            }
        }));
    }
    const postCSSOptions = {
        ...postcssOptions,
        to: filename,
        from: filename
    };
    if (map) {
        postCSSOptions.map = {
            inline: false,
            annotation: false,
            prev: map
        };
    }
    let result;
    let code;
    let outMap;
    // stylus output include plain css. so need remove the repeat item
    const dependencies = new Set(preProcessedSource ? preProcessedSource.dependencies : []);
    // sass has filename self when provided filename option
    dependencies.delete(filename);
    const errors = [];
    if (preProcessedSource && preProcessedSource.errors.length) {
        errors.push(...preProcessedSource.errors);
    }
    const recordPlainCssDependencies = (messages) => {
        messages.forEach(msg => {
            if (msg.type === 'dependency') {
                // postcss output path is absolute position path
                dependencies.add(msg.file);
            }
        });
        return dependencies;
    };
    try {
        result = postcss__default(plugins).process(source, postCSSOptions);
        // In async mode, return a promise.
        if (options.isAsync) {
            return result
                .then(result => ({
                code: result.css || '',
                map: result.map && result.map.toJSON(),
                errors,
                modules: cssModules,
                rawResult: result,
                dependencies: recordPlainCssDependencies(result.messages)
            }))
                .catch(error => ({
                code: '',
                map: undefined,
                errors: [...errors, error],
                rawResult: undefined,
                dependencies
            }));
        }
        recordPlainCssDependencies(result.messages);
        // force synchronous transform (we know we only have sync plugins)
        code = result.css;
        outMap = result.map;
    }
    catch (e) {
        errors.push(e);
    }
    return {
        code: code || ``,
        map: outMap && outMap.toJSON(),
        errors,
        rawResult: result,
        dependencies
    };
}
function preprocess$1(options, preprocessor) {
    return preprocessor(options.source, options.map, {
        filename: options.filename,
        ...options.preprocessOptions
    }, options.preprocessCustomRequire);
}

const defaultExportRE = /((?:^|\n|;)\s*)export(\s*)default/;
const namedDefaultExportRE = /((?:^|\n|;)\s*)export(.+)as(\s*)default/;
/**
 * Utility for rewriting `export default` in a script block into a variable
 * declaration so that we can inject things into it
 */
function rewriteDefault(input, as, parserPlugins) {
    if (!hasDefaultExport(input)) {
        return input + `\nconst ${as} = {}`;
    }
    const replaced = input.replace(defaultExportRE, `$1const ${as} =`);
    if (!hasDefaultExport(replaced)) {
        return replaced;
    }
    // if the script somehow still contains `default export`, it probably has
    // multi-line comments or template strings. fallback to a full parse.
    const s = new MagicString__default(input);
    const ast = parser.parse(input, {
        sourceType: 'module',
        plugins: parserPlugins
    }).program.body;
    ast.forEach(node => {
        if (node.type === 'ExportDefaultDeclaration') {
            s.overwrite(node.start, node.declaration.start, `const ${as} = `);
        }
        if (node.type === 'ExportNamedDeclaration') {
            node.specifiers.forEach(specifier => {
                if (specifier.type === 'ExportSpecifier' &&
                    specifier.exported.name === 'default') {
                    const end = specifier.end;
                    s.overwrite(specifier.start, input.charAt(end) === ',' ? end + 1 : end, ``);
                    s.append(`\nconst ${as} = ${specifier.local.name}`);
                }
            });
        }
    });
    return s.toString();
}
function hasDefaultExport(input) {
    return defaultExportRE.test(input) || namedDefaultExportRE.test(input);
}

function genCssVarsCode(varsExp, scoped, knownBindings) {
    const exp = CompilerDOM.createSimpleExpression(varsExp, false);
    const context = CompilerDOM.createTransformContext(CompilerDOM.createRoot([]), {
        prefixIdentifiers: true
    });
    if (knownBindings) {
        // when compiling <script setup> we already know what bindings are exposed
        // so we can avoid prefixing them from the ctx.
        for (const key in knownBindings) {
            context.identifiers[key] = 1;
        }
    }
    const transformed = CompilerDOM.processExpression(exp, context);
    const transformedString = transformed.type === 4 /* SIMPLE_EXPRESSION */
        ? transformed.content
        : transformed.children
            .map(c => {
            return typeof c === 'string'
                ? c
                : c.content;
        })
            .join('');
    return `__useCssVars__(_ctx => (${transformedString})${scoped ? `, true` : ``})`;
}
// <script setup> already gets the calls injected as part of the transform
// this is only for single normal <script>
function injectCssVarsCalls(sfc, parserPlugins) {
    const script = rewriteDefault(sfc.script.content, `__default__`, parserPlugins);
    let calls = ``;
    for (const style of sfc.styles) {
        const vars = style.attrs.vars;
        if (typeof vars === 'string') {
            calls += genCssVarsCode(vars, !!style.scoped) + '\n';
        }
    }
    return (script +
        `\nimport { useCssVars as __useCssVars__ } from 'vue'\n` +
        `const __injectCSSVars__ = () => {\n${calls}}\n` +
        `const __setup__ = __default__.setup\n` +
        `__default__.setup = __setup__\n` +
        `  ? (props, ctx) => { __injectCSSVars__();return __setup__(props, ctx) }\n` +
        `  : __injectCSSVars__\n` +
        `export default __default__`);
}

let hasWarned = false;
/**
 * Compile `<script setup>`
 * It requires the whole SFC descriptor because we need to handle and merge
 * normal `<script>` + `<script setup>` if both are present.
 */
function compileScript(sfc, options = {}) {
    const { script, scriptSetup, styles, source, filename } = sfc;
    if ( !hasWarned && scriptSetup) {
        hasWarned = true;
        // @ts-ignore `console.info` cannot be null error
        console[console.info ? 'info' : 'log'](`\n[@vue/compiler-sfc] <script setup> is still an experimental proposal.\n` +
            `Follow https://github.com/vuejs/rfcs/pull/182 for its status.\n`);
    }
    const hasCssVars = styles.some(s => typeof s.attrs.vars === 'string');
    const scriptLang = script && script.lang;
    const scriptSetupLang = scriptSetup && scriptSetup.lang;
    const isTS = scriptLang === 'ts' || scriptSetupLang === 'ts';
    const plugins = [...shared.babelParserDefaultPlugins, 'jsx'];
    if (options.babelParserPlugins)
        plugins.push(...options.babelParserPlugins);
    if (isTS)
        plugins.push('typescript', 'decorators-legacy');
    if (!scriptSetup) {
        if (!script) {
            throw new Error(`SFC contains no <script> tags.`);
        }
        if (scriptLang && scriptLang !== 'ts') {
            // do not process non js/ts script blocks
            return script;
        }
        try {
            const scriptAst = parser.parse(script.content, {
                plugins,
                sourceType: 'module'
            }).program.body;
            return {
                ...script,
                content: hasCssVars ? injectCssVarsCalls(sfc, plugins) : script.content,
                bindings: analyzeScriptBindings(scriptAst),
                scriptAst
            };
        }
        catch (e) {
            // silently fallback if parse fails since user may be using custom
            // babel syntax
            return script;
        }
    }
    if (script && scriptLang !== scriptSetupLang) {
        throw new Error(`<script> and <script setup> must have the same language type.`);
    }
    if (scriptSetupLang && scriptSetupLang !== 'ts') {
        // do not process non js/ts script blocks
        return scriptSetup;
    }
    const defaultTempVar = `__default__`;
    const bindings = {};
    const imports = {};
    const setupScopeVars = {};
    const setupExports = {};
    let exportAllIndex = 0;
    let defaultExport;
    let needDefaultExportRefCheck = false;
    let hasAwait = false;
    const checkDuplicateDefaultExport = (node) => {
        if (defaultExport) {
            // <script> already has export default
            throw new Error(`Default export is already declared in normal <script>.\n\n` +
                shared.generateCodeFrame(source, node.start + startOffset, node.start + startOffset + `export default`.length));
        }
    };
    const s = new MagicString__default(source);
    const startOffset = scriptSetup.loc.start.offset;
    const endOffset = scriptSetup.loc.end.offset;
    const scriptStartOffset = script && script.loc.start.offset;
    const scriptEndOffset = script && script.loc.end.offset;
    let scriptAst;
    // 1. process normal <script> first if it exists
    if (script) {
        // import dedupe between <script> and <script setup>
        scriptAst = parser.parse(script.content, {
            plugins,
            sourceType: 'module'
        }).program.body;
        for (const node of scriptAst) {
            if (node.type === 'ImportDeclaration') {
                // record imports for dedupe
                for (const { local: { name } } of node.specifiers) {
                    imports[name] = node.source.value;
                }
            }
            else if (node.type === 'ExportDefaultDeclaration') {
                // export default
                defaultExport = node;
                const start = node.start + scriptStartOffset;
                s.overwrite(start, start + `export default`.length, `const ${defaultTempVar} =`);
            }
            else if (node.type === 'ExportNamedDeclaration' && node.specifiers) {
                const defaultSpecifier = node.specifiers.find(s => s.exported.name === 'default');
                if (defaultSpecifier) {
                    defaultExport = node;
                    // 1. remove specifier
                    if (node.specifiers.length > 1) {
                        s.remove(defaultSpecifier.start + scriptStartOffset, defaultSpecifier.end + scriptStartOffset);
                    }
                    else {
                        s.remove(node.start + scriptStartOffset, node.end + scriptStartOffset);
                    }
                    if (node.source) {
                        // export { x as default } from './x'
                        // rewrite to `import { x as __default__ } from './x'` and
                        // add to top
                        s.prepend(`import { ${defaultSpecifier.local.name} as ${defaultTempVar} } from '${node.source.value}'\n`);
                    }
                    else {
                        // export { x as default }
                        // rewrite to `const __default__ = x` and move to end
                        s.append(`\nconst ${defaultTempVar} = ${defaultSpecifier.local.name}\n`);
                    }
                }
            }
        }
    }
    // 2. check <script setup="xxx"> function signature
    const setupValue = scriptSetup.setup;
    const hasExplicitSignature = typeof setupValue === 'string';
    let propsVar;
    let emitVar;
    let slotsVar;
    let attrsVar;
    let propsType = `{}`;
    let emitType = `(e: string, ...args: any[]) => void`;
    let slotsType = `__Slots__`;
    let attrsType = `Record<string, any>`;
    let propsASTNode;
    let setupCtxASTNode;
    // props/emits declared via types
    const typeDeclaredProps = {};
    const typeDeclaredEmits = new Set();
    // record declared types for runtime props type generation
    const declaredTypes = {};
    if (isTS && hasExplicitSignature) {
        // <script setup="xxx" lang="ts">
        // parse the signature to extract the props/emit variables the user wants
        // we need them to find corresponding type declarations.
        const signatureAST = parser.parse(`(${setupValue})=>{}`, { plugins }).program
            .body[0];
        const params = signatureAST
            .expression.params;
        if (params[0] && params[0].type === 'Identifier') {
            propsASTNode = params[0];
            propsVar = propsASTNode.name;
        }
        if (params[1] && params[1].type === 'ObjectPattern') {
            setupCtxASTNode = params[1];
            for (const p of params[1].properties) {
                if (p.type === 'ObjectProperty' &&
                    p.key.type === 'Identifier' &&
                    p.value.type === 'Identifier') {
                    if (p.key.name === 'emit') {
                        emitVar = p.value.name;
                    }
                    else if (p.key.name === 'slots') {
                        slotsVar = p.value.name;
                    }
                    else if (p.key.name === 'attrs') {
                        attrsVar = p.value.name;
                    }
                }
            }
        }
    }
    // 3. parse <script setup> and  walk over top level statements
    const scriptSetupAst = parser.parse(scriptSetup.content, {
        plugins: [
            ...plugins,
            // allow top level await but only inside <script setup>
            'topLevelAwait'
        ],
        sourceType: 'module'
    }).program.body;
    for (const node of scriptSetupAst) {
        const start = node.start + startOffset;
        let end = node.end + startOffset;
        // import or type declarations: move to top
        // locate comment
        if (node.trailingComments && node.trailingComments.length > 0) {
            const lastCommentNode = node.trailingComments[node.trailingComments.length - 1];
            end = lastCommentNode.end + startOffset;
        }
        // locate the end of whitespace between this statement and the next
        while (end <= source.length) {
            if (!/\s/.test(source.charAt(end))) {
                break;
            }
            end++;
        }
        if (node.type === 'ImportDeclaration') {
            // import declarations are moved to top
            s.move(start, end, 0);
            // dedupe imports
            let prev;
            let removed = 0;
            for (const specifier of node.specifiers) {
                if (imports[specifier.local.name]) {
                    // already imported in <script setup>, dedupe
                    removed++;
                    s.remove(prev ? prev.end + startOffset : specifier.start + startOffset, specifier.end + startOffset);
                }
                else {
                    imports[specifier.local.name] = node.source.value;
                }
                prev = specifier;
            }
            if (removed === node.specifiers.length) {
                s.remove(node.start + startOffset, node.end + startOffset);
            }
        }
        if (node.type === 'ExportNamedDeclaration' && node.exportKind !== 'type') {
            // named exports
            if (node.declaration) {
                // variable/function/class declarations.
                // remove leading `export ` keyword
                s.remove(start, start + 7);
                walkDeclaration(node.declaration, setupExports);
            }
            if (node.specifiers.length) {
                // named export with specifiers
                if (node.source) {
                    // export { x } from './x'
                    // change it to import and move to top
                    s.overwrite(start, start + 6, 'import');
                    s.move(start, end, 0);
                }
                else {
                    // export { x }
                    s.remove(start, end);
                }
                for (const specifier of node.specifiers) {
                    if (specifier.type === 'ExportDefaultSpecifier') {
                        // export default from './x'
                        // rewrite to `import __default__ from './x'`
                        checkDuplicateDefaultExport(node);
                        defaultExport = node;
                        s.overwrite(specifier.exported.start + startOffset, specifier.exported.start + startOffset + 7, defaultTempVar);
                    }
                    else if (specifier.type === 'ExportSpecifier') {
                        if (specifier.exported.name === 'default') {
                            checkDuplicateDefaultExport(node);
                            defaultExport = node;
                            // 1. remove specifier
                            if (node.specifiers.length > 1) {
                                // removing the default specifier from a list of specifiers.
                                // look ahead until we reach the first non , or whitespace char.
                                let end = specifier.end + startOffset;
                                while (end < source.length) {
                                    if (/[^,\s]/.test(source.charAt(end))) {
                                        break;
                                    }
                                    end++;
                                }
                                s.remove(specifier.start + startOffset, end);
                            }
                            else {
                                s.remove(node.start + startOffset, node.end + startOffset);
                            }
                            if (!node.source) {
                                // export { x as default, ... }
                                const local = specifier.local.name;
                                if (setupScopeVars[local] || setupExports[local]) {
                                    throw new Error(`Cannot export locally defined variable as default in <script setup>.\n` +
                                        `Default export must be an object literal with no reference to local scope.\n` +
                                        shared.generateCodeFrame(source, specifier.start + startOffset, specifier.end + startOffset));
                                }
                                // rewrite to `const __default__ = x` and move to end
                                s.append(`\nconst ${defaultTempVar} = ${local}\n`);
                            }
                            else {
                                // export { x as default } from './x'
                                // rewrite to `import { x as __default__ } from './x'` and
                                // add to top
                                s.prepend(`import { ${specifier.local.name} as ${defaultTempVar} } from '${node.source.value}'\n`);
                            }
                        }
                        else {
                            setupExports[specifier.exported.name] = true;
                            if (node.source) {
                                imports[specifier.exported.name] = node.source.value;
                            }
                        }
                    }
                }
            }
        }
        if (node.type === 'ExportAllDeclaration') {
            // export * from './x'
            s.overwrite(start, node.source.start + startOffset, `import * as __export_all_${exportAllIndex++}__ from `);
            s.move(start, end, 0);
        }
        if (node.type === 'ExportDefaultDeclaration') {
            checkDuplicateDefaultExport(node);
            // export default {} inside <script setup>
            // this should be kept in module scope - move it to the end
            s.move(start, end, source.length);
            s.overwrite(start, start + `export default`.length, `const __default__ =`);
            // save it for analysis when all imports and variable declarations have
            // been recorded
            defaultExport = node;
            needDefaultExportRefCheck = true;
        }
        if ((node.type === 'VariableDeclaration' ||
            node.type === 'FunctionDeclaration' ||
            node.type === 'ClassDeclaration') &&
            !node.declare) {
            walkDeclaration(node, setupScopeVars);
        }
        // Type declarations
        if (node.type === 'VariableDeclaration' && node.declare) {
            s.remove(start, end);
            for (const { id } of node.declarations) {
                if (id.type === 'Identifier') {
                    if (id.typeAnnotation &&
                        id.typeAnnotation.type === 'TSTypeAnnotation') {
                        const typeNode = id.typeAnnotation.typeAnnotation;
                        const typeString = source.slice(typeNode.start + startOffset, typeNode.end + startOffset);
                        if (typeNode.type === 'TSTypeLiteral') {
                            if (id.name === propsVar) {
                                propsType = typeString;
                                extractRuntimeProps(typeNode, typeDeclaredProps, declaredTypes);
                            }
                            else if (id.name === slotsVar) {
                                slotsType = typeString;
                            }
                            else if (id.name === attrsVar) {
                                attrsType = typeString;
                            }
                        }
                        else if (id.name === emitVar &&
                            typeNode.type === 'TSFunctionType') {
                            emitType = typeString;
                            extractRuntimeEmits(typeNode, typeDeclaredEmits);
                        }
                    }
                }
            }
        }
        if (node.type === 'TSDeclareFunction' &&
            node.id &&
            node.id.name === emitVar) {
            const index = node.id.start + startOffset;
            s.overwrite(index, index + emitVar.length, '__emit__');
            emitType = `typeof __emit__`;
            extractRuntimeEmits(node, typeDeclaredEmits);
        }
        // move all type declarations to outer scope
        if (node.type.startsWith('TS') ||
            (node.type === 'ExportNamedDeclaration' && node.exportKind === 'type')) {
            recordType(node, declaredTypes);
            s.move(start, end, 0);
        }
        // walk statements & named exports / variable declarations for top level
        // await
        if (node.type === 'VariableDeclaration' ||
            (node.type === 'ExportNamedDeclaration' &&
                node.declaration &&
                node.declaration.type === 'VariableDeclaration') ||
            node.type.endsWith('Statement')) {
            estreeWalker.walk(node, {
                enter(node) {
                    if (isFunction(node)) {
                        this.skip();
                    }
                    if (node.type === 'AwaitExpression') {
                        hasAwait = true;
                    }
                }
            });
        }
    }
    // 4. check default export to make sure it doesn't reference setup scope
    // variables
    if (needDefaultExportRefCheck) {
        checkDefaultExport(defaultExport, setupScopeVars, imports, setupExports, source, startOffset);
    }
    // 5. remove non-script content
    if (script) {
        if (startOffset < scriptStartOffset) {
            // <script setup> before <script>
            s.remove(endOffset, scriptStartOffset);
            s.remove(scriptEndOffset, source.length);
        }
        else {
            // <script> before <script setup>
            s.remove(0, scriptStartOffset);
            s.remove(scriptEndOffset, startOffset);
            s.remove(endOffset, source.length);
        }
    }
    else {
        // only <script setup>
        s.remove(0, startOffset);
        s.remove(endOffset, source.length);
    }
    // 5. finalize setup argument signature.
    let args = ``;
    if (isTS) {
        if (slotsType === '__Slots__') {
            s.prepend(`import { Slots as __Slots__ } from 'vue'\n`);
        }
        const ctxType = `{
  emit: ${emitType},
  slots: ${slotsType},
  attrs: ${attrsType}
}`;
        if (hasExplicitSignature) {
            // inject types to user signature
            args = setupValue;
            const ss = new MagicString__default(args);
            if (propsASTNode) {
                // compensate for () wraper offset
                ss.appendRight(propsASTNode.end - 1, `: ${propsType}`);
            }
            if (setupCtxASTNode) {
                ss.appendRight(setupCtxASTNode.end - 1, `: ${ctxType}`);
            }
            args = ss.toString();
        }
    }
    else {
        args = hasExplicitSignature ? setupValue : ``;
    }
    // 6. wrap setup code with function.
    // export the content of <script setup> as a named export, `setup`.
    // this allows `import { setup } from '*.vue'` for testing purposes.
    s.prependLeft(startOffset, `\nexport ${hasAwait ? `async ` : ``}function setup(${args}) {\n`);
    // generate return statement
    let returned = `{ ${Object.keys(setupExports).join(', ')} }`;
    // handle `export * from`. We need to call `toRefs` on the imported module
    // object before merging.
    if (exportAllIndex > 0) {
        s.prepend(`import { toRefs as __toRefs__ } from 'vue'\n`);
        for (let i = 0; i < exportAllIndex; i++) {
            returned += `,\n  __toRefs__(__export_all_${i}__)`;
        }
        returned = `Object.assign(\n  ${returned}\n)`;
    }
    // inject `useCssVars` calls
    if (hasCssVars) {
        s.prepend(`import { useCssVars as __useCssVars__ } from 'vue'\n`);
        for (const style of styles) {
            const vars = style.attrs.vars;
            if (typeof vars === 'string') {
                s.prependRight(endOffset, `\n${genCssVarsCode(vars, !!style.scoped, setupExports)}`);
            }
        }
    }
    s.appendRight(endOffset, `\nreturn ${returned}\n}\n\n`);
    // 7. finalize default export
    if (isTS) {
        // for TS, make sure the exported type is still valid type with
        // correct props information
        s.prepend(`import { defineComponent as __define__ } from 'vue'\n`);
        // we have to use object spread for types to be merged properly
        // user's TS setting should compile it down to proper targets
        const def = defaultExport ? `\n  ...${defaultTempVar},` : ``;
        const runtimeProps = genRuntimeProps(typeDeclaredProps);
        const runtimeEmits = genRuntimeEmits(typeDeclaredEmits);
        s.append(`export default __define__({${def}${runtimeProps}${runtimeEmits}\n  setup\n})`);
    }
    else {
        if (defaultExport) {
            s.append(`${defaultTempVar}.setup = setup\nexport default ${defaultTempVar}`);
        }
        else {
            s.append(`export default { setup }`);
        }
    }
    // 8. expose bindings for template compiler optimization
    if (scriptAst) {
        Object.assign(bindings, analyzeScriptBindings(scriptAst));
    }
    Object.keys(setupExports).forEach(key => {
        bindings[key] = 'setup';
    });
    Object.keys(typeDeclaredProps).forEach(key => {
        bindings[key] = 'props';
    });
    Object.assign(bindings, analyzeScriptBindings(scriptSetupAst));
    s.trim();
    return {
        ...scriptSetup,
        bindings,
        content: s.toString(),
        map: s.generateMap({
            source: filename,
            hires: true,
            includeContent: true
        }),
        scriptAst,
        scriptSetupAst
    };
}
function walkDeclaration(node, bindings) {
    if (node.type === 'VariableDeclaration') {
        // export const foo = ...
        for (const { id } of node.declarations) {
            if (id.type === 'Identifier') {
                bindings[id.name] = true;
            }
            else if (id.type === 'ObjectPattern') {
                walkObjectPattern(id, bindings);
            }
            else if (id.type === 'ArrayPattern') {
                walkArrayPattern(id, bindings);
            }
        }
    }
    else if (node.type === 'FunctionDeclaration' ||
        node.type === 'ClassDeclaration') {
        // export function foo() {} / export class Foo {}
        // export declarations must be named.
        bindings[node.id.name] = true;
    }
}
function walkObjectPattern(node, bindings) {
    for (const p of node.properties) {
        if (p.type === 'ObjectProperty') {
            // key can only be Identifier in ObjectPattern
            if (p.key.type === 'Identifier') {
                if (p.key === p.value) {
                    // const { x } = ...
                    bindings[p.key.name] = true;
                }
                else {
                    walkPattern(p.value, bindings);
                }
            }
        }
        else {
            // ...rest
            // argument can only be identifer when destructuring
            bindings[p.argument.name] = true;
        }
    }
}
function walkArrayPattern(node, bindings) {
    for (const e of node.elements) {
        e && walkPattern(e, bindings);
    }
}
function walkPattern(node, bindings) {
    if (node.type === 'Identifier') {
        bindings[node.name] = true;
    }
    else if (node.type === 'RestElement') {
        // argument can only be identifer when destructuring
        bindings[node.argument.name] = true;
    }
    else if (node.type === 'ObjectPattern') {
        walkObjectPattern(node, bindings);
    }
    else if (node.type === 'ArrayPattern') {
        walkArrayPattern(node, bindings);
    }
    else if (node.type === 'AssignmentPattern') {
        if (node.left.type === 'Identifier') {
            bindings[node.left.name] = true;
        }
        else {
            walkPattern(node.left, bindings);
        }
    }
}
function recordType(node, declaredTypes) {
    if (node.type === 'TSInterfaceDeclaration') {
        declaredTypes[node.id.name] = [`Object`];
    }
    else if (node.type === 'TSTypeAliasDeclaration') {
        declaredTypes[node.id.name] = inferRuntimeType(node.typeAnnotation, declaredTypes);
    }
    else if (node.type === 'ExportNamedDeclaration' && node.declaration) {
        recordType(node.declaration, declaredTypes);
    }
}
function extractRuntimeProps(node, props, declaredTypes) {
    for (const m of node.members) {
        if (m.type === 'TSPropertySignature' && m.key.type === 'Identifier') {
            props[m.key.name] = {
                key: m.key.name,
                required: !m.optional,
                type:  m.typeAnnotation
                    ? inferRuntimeType(m.typeAnnotation.typeAnnotation, declaredTypes)
                    : [`null`]
            };
        }
    }
}
function inferRuntimeType(node, declaredTypes) {
    switch (node.type) {
        case 'TSStringKeyword':
            return ['String'];
        case 'TSNumberKeyword':
            return ['Number'];
        case 'TSBooleanKeyword':
            return ['Boolean'];
        case 'TSObjectKeyword':
            return ['Object'];
        case 'TSTypeLiteral':
            // TODO (nice to have) generate runtime property validation
            return ['Object'];
        case 'TSFunctionType':
            return ['Function'];
        case 'TSArrayType':
        case 'TSTupleType':
            // TODO (nice to have) generate runtime element type/length checks
            return ['Array'];
        case 'TSLiteralType':
            switch (node.literal.type) {
                case 'StringLiteral':
                    return ['String'];
                case 'BooleanLiteral':
                    return ['Boolean'];
                case 'NumericLiteral':
                case 'BigIntLiteral':
                    return ['Number'];
                default:
                    return [`null`];
            }
        case 'TSTypeReference':
            if (node.typeName.type === 'Identifier') {
                if (declaredTypes[node.typeName.name]) {
                    return declaredTypes[node.typeName.name];
                }
                switch (node.typeName.name) {
                    case 'Array':
                    case 'Function':
                    case 'Object':
                    case 'Set':
                    case 'Map':
                    case 'WeakSet':
                    case 'WeakMap':
                        return [node.typeName.name];
                    case 'Record':
                    case 'Partial':
                    case 'Readonly':
                    case 'Pick':
                    case 'Omit':
                    case 'Exclude':
                    case 'Extract':
                    case 'Required':
                    case 'InstanceType':
                        return ['Object'];
                }
            }
            return [`null`];
        case 'TSUnionType':
            return [
                ...new Set([].concat(node.types.map(t => inferRuntimeType(t, declaredTypes))))
            ];
        case 'TSIntersectionType':
            return ['Object'];
        default:
            return [`null`]; // no runtime check
    }
}
function genRuntimeProps(props) {
    const keys = Object.keys(props);
    if (!keys.length) {
        return ``;
    }
    return `\n  props: {\n    ${keys
        .map(key => {
        const { type, required } = props[key];
        return `${key}: { type: ${toRuntimeTypeString(type)}, required: ${required} }`;
    })
        .join(',\n    ')}\n  } as unknown as undefined,`;
}
function toRuntimeTypeString(types) {
    return types.some(t => t === 'null')
        ? `null`
        : types.length > 1
            ? `[${types.join(', ')}]`
            : types[0];
}
function extractRuntimeEmits(node, emits) {
    const eventName = node.type === 'TSDeclareFunction' ? node.params[0] : node.parameters[0];
    if (eventName.type === 'Identifier' &&
        eventName.typeAnnotation &&
        eventName.typeAnnotation.type === 'TSTypeAnnotation') {
        const typeNode = eventName.typeAnnotation.typeAnnotation;
        if (typeNode.type === 'TSLiteralType') {
            emits.add(String(typeNode.literal.value));
        }
        else if (typeNode.type === 'TSUnionType') {
            for (const t of typeNode.types) {
                if (t.type === 'TSLiteralType') {
                    emits.add(String(t.literal.value));
                }
            }
        }
    }
}
function genRuntimeEmits(emits) {
    return emits.size
        ? `\n  emits: [${Array.from(emits)
            .map(p => JSON.stringify(p))
            .join(', ')}] as unknown as undefined,`
        : ``;
}
/**
 * export default {} inside `<script setup>` cannot access variables declared
 * inside since it's hoisted. Walk and check to make sure.
 */
function checkDefaultExport(root, scopeVars, imports, exports, source, offset) {
    const knownIds = Object.create(null);
    estreeWalker.walk(root, {
        enter(node, parent) {
            if (node.type === 'Identifier') {
                if (!knownIds[node.name] &&
                    !isStaticPropertyKey(node, parent) &&
                    (scopeVars[node.name] || (!imports[node.name] && exports[node.name]))) {
                    throw new Error(`\`export default\` in <script setup> cannot reference locally ` +
                        `declared variables because it will be hoisted outside of the ` +
                        `setup() function. If your component options requires initialization ` +
                        `in the module scope, use a separate normal <script> to export ` +
                        `the options instead.\n\n` +
                        shared.generateCodeFrame(source, node.start + offset, node.end + offset));
                }
            }
            else if (isFunction(node)) {
                // walk function expressions and add its arguments to known identifiers
                // so that we don't prefix them
                node.params.forEach(p => estreeWalker.walk(p, {
                    enter(child, parent) {
                        if (child.type === 'Identifier' &&
                            // do not record as scope variable if is a destructured key
                            !isStaticPropertyKey(child, parent) &&
                            // do not record if this is a default value
                            // assignment of a destructured variable
                            !(parent &&
                                parent.type === 'AssignmentPattern' &&
                                parent.right === child)) {
                            const { name } = child;
                            if (node.scopeIds && node.scopeIds.has(name)) {
                                return;
                            }
                            if (name in knownIds) {
                                knownIds[name]++;
                            }
                            else {
                                knownIds[name] = 1;
                            }
                            (node.scopeIds || (node.scopeIds = new Set())).add(name);
                        }
                    }
                }));
            }
        },
        leave(node) {
            if (node.scopeIds) {
                node.scopeIds.forEach((id) => {
                    knownIds[id]--;
                    if (knownIds[id] === 0) {
                        delete knownIds[id];
                    }
                });
            }
        }
    });
}
function isStaticPropertyKey(node, parent) {
    return (parent &&
        (parent.type === 'ObjectProperty' || parent.type === 'ObjectMethod') &&
        !parent.computed &&
        parent.key === node);
}
function isFunction(node) {
    return /Function(?:Expression|Declaration)$|Method$/.test(node.type);
}
function getObjectExpressionKeys(node) {
    const keys = [];
    for (const prop of node.properties) {
        if ((prop.type === 'ObjectProperty' || prop.type === 'ObjectMethod') &&
            !prop.computed) {
            if (prop.key.type === 'Identifier') {
                keys.push(prop.key.name);
            }
            else if (prop.key.type === 'StringLiteral') {
                keys.push(prop.key.value);
            }
        }
    }
    return keys;
}
function getArrayExpressionKeys(node) {
    const keys = [];
    for (const element of node.elements) {
        if (element && element.type === 'StringLiteral') {
            keys.push(element.value);
        }
    }
    return keys;
}
function getObjectOrArrayExpressionKeys(property) {
    if (property.value.type === 'ArrayExpression') {
        return getArrayExpressionKeys(property.value);
    }
    if (property.value.type === 'ObjectExpression') {
        return getObjectExpressionKeys(property.value);
    }
    return [];
}
/**
 * Analyze bindings in normal `<script>`
 * Note that `compileScriptSetup` already analyzes bindings as part of its
 * compilation process so this should only be used on single `<script>` SFCs.
 */
function analyzeScriptBindings(ast) {
    const bindings = {};
    for (const node of ast) {
        if (node.type === 'ExportDefaultDeclaration' &&
            node.declaration.type === 'ObjectExpression') {
            for (const property of node.declaration.properties) {
                if (property.type === 'ObjectProperty' &&
                    !property.computed &&
                    property.key.type === 'Identifier') {
                    // props
                    if (property.key.name === 'props') {
                        // props: ['foo']
                        // props: { foo: ... }
                        for (const key of getObjectOrArrayExpressionKeys(property)) {
                            bindings[key] = 'props';
                        }
                    }
                    // inject
                    else if (property.key.name === 'inject') {
                        // inject: ['foo']
                        // inject: { foo: {} }
                        for (const key of getObjectOrArrayExpressionKeys(property)) {
                            bindings[key] = 'options';
                        }
                    }
                    // computed & methods
                    else if (property.value.type === 'ObjectExpression' &&
                        (property.key.name === 'computed' ||
                            property.key.name === 'methods')) {
                        // methods: { foo() {} }
                        // computed: { foo() {} }
                        for (const key of getObjectExpressionKeys(property.value)) {
                            bindings[key] = 'options';
                        }
                    }
                }
                // setup & data
                else if (property.type === 'ObjectMethod' &&
                    property.key.type === 'Identifier' &&
                    (property.key.name === 'setup' || property.key.name === 'data')) {
                    for (const bodyItem of property.body.body) {
                        // setup() {
                        //   return {
                        //     foo: null
                        //   }
                        // }
                        if (bodyItem.type === 'ReturnStatement' &&
                            bodyItem.argument &&
                            bodyItem.argument.type === 'ObjectExpression') {
                            for (const key of getObjectExpressionKeys(bodyItem.argument)) {
                                bindings[key] = property.key.name;
                            }
                        }
                    }
                }
            }
        }
    }
    return bindings;
}

exports.generateCodeFrame = compilerCore.generateCodeFrame;
exports.compileScript = compileScript;
exports.compileStyle = compileStyle;
exports.compileStyleAsync = compileStyleAsync;
exports.compileTemplate = compileTemplate;
exports.parse = parse;
exports.rewriteDefault = rewriteDefault;
