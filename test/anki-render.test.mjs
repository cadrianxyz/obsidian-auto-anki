// Field rendering for Anki: Markdown, built-in MathJax delimiters, safe links and cloze markup.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderAnkiField } from '../src/anki/render';

describe('Anki field rendering', () => {
	test('plain text stays plain, and line breaks become <br>', () => {
		assert.equal(renderAnkiField('Base of binary?'), 'Base of binary?');
		assert.equal(renderAnkiField('First line\nSecond line'), 'First line<br>Second line');
	});

	test('inline maths uses Anki\'s \\( \\) delimiters and keeps underscores and asterisks', () => {
		assert.equal(renderAnkiField('Let $x^2$ be'), 'Let \\(x^2\\) be');
		assert.equal(renderAnkiField('$a_1 * b_2 * c$'), '\\(a_1 * b_2 * c\\)');
	});

	test('display maths uses \\[ \\] delimiters, including across lines', () => {
		assert.equal(renderAnkiField('$$\nE = mc^2\n$$'), '\\[E = mc^2\\]');
	});

	test('dollar amounts and spaced dollars are not read as maths', () => {
		assert.equal(renderAnkiField('It costs $5 and $10'), 'It costs $5 and $10');
		assert.doesNotMatch(renderAnkiField('Price $ 5 and $ 6'), /\\\(/);
	});

	test('escaped dollars, code spans and code blocks keep their dollar signs', () => {
		assert.equal(renderAnkiField('Cost \\$5'), 'Cost $5');
		assert.equal(renderAnkiField('Use `$x$` here'), 'Use <code>$x$</code> here');
		assert.match(renderAnkiField('```\n$a$\n```'), /<pre><code>\$a\$\n<\/code><\/pre>/);
	});

	test('maths content is escaped so it cannot become markup', () => {
		assert.equal(renderAnkiField('$a<b & c>d$'), '\\(a&lt;b &amp; c&gt;d\\)');
	});

	test('raw HTML from a note is shown as text, not run in the card', () => {
		const html = renderAnkiField('<script>alert(1)</script> and <img src=x onerror=alert(1)>');
		assert.doesNotMatch(html, /<script|<img/);
		assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
	});

	test('links with unsafe schemes lose their target; ordinary links keep it', () => {
		assert.match(renderAnkiField('[x](javascript:alert(1))'), /<a href="">x<\/a>/);
		// The parser does not treat a target with a tab as a link, so no anchor is created at all.
		assert.doesNotMatch(renderAnkiField('[x](java\tscript:alert(1))'), /<a /);
		assert.match(renderAnkiField('[docs](https://docs.ankiweb.net/)'), /href="https:\/\/docs\.ankiweb\.net\/"/);
	});

	test('cloze deletions pass through unchanged', () => {
		assert.match(renderAnkiField('{{c1::Paris}} is the capital of France'), /\{\{c1::Paris\}\} is the capital of France/);
		assert.match(renderAnkiField('The formula {{c1::$E = mc^2$}}'), /\{\{c1::\\\(E = mc\^2\\\)\}\}/);
	});

	test('ordinary Markdown is rendered', () => {
		assert.equal(renderAnkiField('**bold** and *italic*'), '<strong>bold</strong> and <em>italic</em>');
	});
});
