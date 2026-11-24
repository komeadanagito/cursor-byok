//! Links function-body chunks and attached documentation to their declaration chunk.

use tree_sitter::{Node, Tree};

use crate::chunk::ChunkBoundary;

pub(super) fn collect(tree: &Tree, chunks: &[ChunkBoundary]) -> Vec<Option<usize>> {
    let mut anchors = vec![None; chunks.len()];
    let mut cursor = tree.walk();
    loop {
        let node = cursor.node();
        if let Some((declaration, body)) = function(node) {
            let start = declaration.start_byte();
            let anchor = chunks.partition_point(|chunk| chunk.end <= start);
            if chunks.get(anchor).is_some_and(|chunk| chunk.start <= start) {
                anchors[anchor] = None;
                if let Some((start, end)) = attached_comments(node) {
                    let first = chunks.partition_point(|chunk| chunk.start < start);
                    for (chunk, target) in chunks[first..].iter().zip(&mut anchors[first..]) {
                        if chunk.end > end {
                            break;
                        }
                        *target = Some(anchor);
                    }
                }
                for (chunk, target) in chunks[anchor + 1..]
                    .iter()
                    .zip(&mut anchors[anchor + 1..])
                    .take_while(|(chunk, _)| chunk.start < body.end_byte())
                {
                    if chunk.start >= body.start_byte() && chunk.end <= body.end_byte() {
                        *target = Some(anchor);
                    }
                }
            }
        }
        if cursor.goto_first_child() {
            continue;
        }
        while !cursor.goto_next_sibling() {
            if !cursor.goto_parent() {
                return anchors;
            }
        }
    }
}

fn attached_comments(mut declaration: Node<'_>) -> Option<(usize, usize)> {
    while let Some(parent) = declaration.parent().filter(|parent| {
        matches!(
            parent.kind(),
            "export_statement" | "decorated_definition" | "template_declaration"
        )
    }) {
        declaration = parent;
    }
    let mut next = declaration;
    let mut range = None;
    while let Some(comment) = next.prev_named_sibling() {
        if !matches!(comment.kind(), "comment" | "line_comment" | "block_comment")
            || comment.end_position().row + 1 != next.start_position().row
            || comment
                .prev_sibling()
                .is_some_and(|prev| prev.end_position().row == comment.start_position().row)
        {
            break;
        }
        let end = range.map_or(comment.end_byte(), |(_, end)| end);
        range = Some((comment.start_byte(), end));
        next = comment;
    }
    range
}

fn function(node: Node<'_>) -> Option<(Node<'_>, Node<'_>)> {
    let declaration = match node.kind() {
        "function_item"
        | "function_definition"
        | "function_declaration"
        | "generator_function_declaration"
        | "method_definition"
        | "method_declaration"
        | "constructor_declaration"
        | "compact_constructor_declaration" => node
            .child_by_field_name("name")
            .or_else(|| node.child_by_field_name("declarator"))
            .unwrap_or(node),
        "arrow_function" | "function_expression" | "generator_function" => {
            let parent = node
                .parent()
                .filter(|parent| parent.kind() == "variable_declarator")?;
            parent.child_by_field_name("name")?
        }
        _ => return None,
    };
    Some((declaration, node.child_by_field_name("body")?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::language::parser_for;

    #[test]
    fn detached_file_comments_and_trailing_comments_do_not_describe_the_next_function() {
        for source in [
            "/* file policy */\n\nfunction adjust() {}",
            "let x = 1; // literal example\nfunction adjust() {}",
        ] {
            let tree = parser_for("javascript")
                .unwrap()
                .parse(source, None)
                .unwrap();
            let declaration = tree
                .root_node()
                .named_child(tree.root_node().named_child_count() as u32 - 1)
                .unwrap();
            assert_eq!(declaration.kind(), "function_declaration");
            assert!(attached_comments(declaration).is_none());
        }
    }

    #[test]
    fn a_chunk_spanning_two_functions_does_not_lend_evidence_to_either_declaration() {
        let source = "function build() { read(); write(); } function poll() { wait(); }";
        let write = source.find("write").unwrap();
        let read = source.find("read").unwrap();
        let wait = source.find("wait").unwrap();
        let tree = parser_for("javascript")
            .unwrap()
            .parse(source, None)
            .unwrap();
        let chunks = [
            ChunkBoundary {
                start: 0,
                end: read,
            },
            ChunkBoundary {
                start: read,
                end: write,
            },
            ChunkBoundary {
                start: write,
                end: wait,
            },
            ChunkBoundary {
                start: wait,
                end: source.len(),
            },
        ];
        assert_eq!(collect(&tree, &chunks), [None, Some(0), None, Some(2)]);
    }
}
