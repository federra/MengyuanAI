"""Link successful images through explicit IDs in the same completion transaction."""
from copy import deepcopy
from uuid import UUID

from shortfilm.assets.strict import append_board, current_board, ref_entity
from shortfilm.media.models import ShotReferenceVersion
from shortfilm.media.sources import outcome_stale, reference_version


def link_generated_image(db, project, job, output):
    if not output.kind.startswith("image.") or outcome_stale(db, project, output):
        return
    version = current_board(db, project.id)
    if not version:
        return
    if output.kind == "image.position":
        value = deepcopy(version.body)
        shot = next((s for s in value["shots"] if s["id"] == str(output.target_id)), None)
        if shot is None or str(output.file_id) in shot["refs"]["positions"]:
            return
        shot["refs"]["positions"].append(str(output.file_id))
        append_board(db, project, version, value)
        return
    eid = UUID(str(output.target_id))
    for shot in version.body["shots"]:
        for group in ("characters", "scenes", "props"):
            for ref in shot["refs"][group]:
                if ref_entity(db, project.id, shot["id"], ref) != eid:
                    continue
                old = reference_version(db, shot["id"], ref)
                if old and old.file_id == output.file_id:
                    continue
                db.add(ShotReferenceVersion(project_id=project.id, shot_id=UUID(shot["id"]), ref_id=UUID(ref), entity_id=eid, file_id=output.file_id, revision=(old.revision if old else 0) + 1))
    db.flush()
