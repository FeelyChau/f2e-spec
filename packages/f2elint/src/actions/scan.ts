import path from 'path';
import fs from 'fs-extra';
import execa from 'execa';
import glob from 'glob';
import prettier from 'prettier';
import * as eslint from '../lints/eslint';
import * as stylelint from '../lints/stylelint';
import * as markdownLint from '../lints/markdownlint';
import {
  PKG_NAME,
  ESLINT_FILE_EXT,
  STYLELINT_FILE_EXT,
  MARKDOWN_LINT_FILE_EXT,
} from '../utils/constants';
import type { ScanOptions, ScanResult, PKG, Config, ScanReport } from '../types';

export default async (options: ScanOptions): Promise<ScanReport> => {
  const { cwd, include, quiet, fix, outputReport } = options;
  const getLintFiles = (ext: string[]): string | string[] => {
    const { files } = options;
    if (files) return files.filter((name) => ext.includes(path.extname(name)));
    const pattern = `**/*.{${ext.map((t) => t.replace(/^\./, '')).join(',')}}`;
    return path.resolve(cwd, include, pattern);
  };
  const readConfigFile = (pth: string): any => {
    const localPath = path.resolve(cwd, pth);
    return fs.existsSync(localPath) ? require(localPath) : {};
  };
  const readIgnore = (filepath: string): string[] => {
    const localPath = path.resolve(cwd, filepath);
    if (fs.existsSync(localPath)) {
      const content = fs.readFileSync(localPath, 'utf8') || '';
      return content
        .split(/\r?\n/)
        .map((str) => str.trim())
        .filter((str) => str && !str.startsWith('#'));
    }
    return [];
  };
  const pkg: PKG = readConfigFile('package.json');
  const config: Config = readConfigFile(`${PKG_NAME}.config.js`);
  const runErrors: Error[] = [];
  const eslintIgnore = readIgnore('.eslintignore');
  const stylelintIgnore = readIgnore('.stylelintignore');
  let results: ScanResult[] = [];

  // prettier
  if (fix && config.enablePrettier !== false) {
    let files = getLintFiles([...ESLINT_FILE_EXT, ...STYLELINT_FILE_EXT]);
    if (typeof files === 'string') {
      files = glob.sync(files, { cwd, ignore: [...eslintIgnore, ...stylelintIgnore] });
    }
    files.forEach((filePath) => {
      const text = fs.readFileSync(filePath, 'utf8');
      prettier.resolveConfig(filePath).then((options) => {
        const formatted = prettier.format(text, options);
        fs.writeFileSync(filePath, formatted, 'utf8');
      });
    });
  }

  // eslint
  try {
    const files = getLintFiles(ESLINT_FILE_EXT);
    const cli = new eslint.ESLint(eslint.getLintConfig(options, pkg, config));
    const reports = await cli.lintFiles(files);
    fix && (await eslint.ESLint.outputFixes(reports));
    results = results.concat(eslint.formatResults(reports, quiet));
  } catch (e) {
    runErrors.push(e);
  }

  // stylelint
  if (config.enableStylelint !== false) {
    try {
      const files = getLintFiles(STYLELINT_FILE_EXT);
      const data = await stylelint.lint({
        ...stylelint.getLintConfig(options, pkg, config),
        files,
      });
      results = results.concat(stylelint.formatResults(data.results, quiet));
    } catch (e) {
      runErrors.push(e);
    }
  }

  // markdown
  if (config.enableMarkdownlint !== false) {
    try {
      const files = options.files
        ? getLintFiles(MARKDOWN_LINT_FILE_EXT)
        : glob.sync('**/*.md', { cwd, ignore: 'node_modules/**' });
      const data = await markdownLint.lint({
        ...markdownLint.getLintConfig(options),
        files,
      });
      results = results.concat(markdownLint.formatResults(data, quiet));
    } catch (e) {
      runErrors.push(e);
    }
  }

  // prettier 格式化
  if (config.enablePrettier && options.fix) {
    try {
      const ext = [...ESLINT_FILE_EXT, ...STYLELINT_FILE_EXT];
      const files = options.files
        ? getLintFiles(ext)
        : glob.sync(`**/*.{${ext.map((t) => t.replace(/^\./, '')).join(',')}}`, {
            cwd,
            ignore: 'node_modules/**',
          });
      execa.sync(path.resolve(__dirname, '../../node_modules/.bin/prettier'), ['-w', ...files]);
    } catch (e) {
      runErrors.push(e);
    }
  }

  // 生成报告报告文件
  if (outputReport) {
    const reportPath = path.resolve(process.cwd(), `./${PKG_NAME}-report.json`);
    fs.outputFile(reportPath, JSON.stringify(results, null, 2), () => {});
  }

  return {
    results,
    errorCount: results.reduce((count, { errorCount }) => count + errorCount, 0),
    warningCount: results.reduce((count, { warningCount }) => count + warningCount, 0),
    runErrors,
  };
};
