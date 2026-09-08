"""Supported paid text commands, shared by routing, dispatch, execution and recovery."""

KEYS = {
    "story.generate": "novel",
    "story.revise": "novelRevision",
    "idea.revise": "ideaRefine",
    "script.generate": "script",
    "board.generate": "storyboard",
    "script.revise": "scriptRefine",
    "board.revise": "boardRefine",
    "story.review": "storyReview",
    "script.review": "scriptReview",
    "board.review": "review",
    "story.repair": "novelRevision",
    "script.repair": "scriptRepair",
    "board.repair": "boardRepair",
}


def is_text(kind):
    return kind in KEYS
