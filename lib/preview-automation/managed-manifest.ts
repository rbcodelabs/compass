import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Reviewed SQL at main 254cbe2. These are intentional approval pins, not generated
 * runtime metadata. Any manifest/file change requires another complete migration
 * audit and an explicit code review of these pins; never refresh automatically.
 * The only runtime SQL exception is runner's exact001 CREATE SCHEMA public skip.
 *
 * `062_mcp_connectors` is pinned by the ADR-0018 connector PR and has NOT been
 * through that audit yet — it is here because `assertReviewedManagedManifest`
 * pins membership as well as digests, so a new migration cannot be registered
 * without touching this map. Treat the pin as a review request, not a pass:
 * re-read the SQL and confirm the digest before merging.
 */
const REVIEWED_SQL_SHA256: Readonly<Record<string, string>> = {
  "001_init": "f22fed1ed336c56fbfb3380e0497c45ba355efd14906f0e4c8f4c1a5279eb12e",
  "002_custom_fields": "261b31bfd4bbbaa05c5be06a5e9371b64a10d725975e70a2ba751173fa6cdb01",
  "003_fix_custom_field_tables": "3442152b672af6780400a6032fc4bbb04f940663ee4779285accdc76db73081e",
  "004_squads": "19ffcee2b5035e313cc2ae270563c0e0a0792e7998a000fc524902796449c048",
  "005_cross_links": "8b3163d3b70704e9976b1d8d654825a1f9531c7230a848f8010d4d7c3b61768e",
  "006_api_keys": "7db783507f62d45df99f688a49e44a4135c13ef215232ff9cdea24014f0e0d3c", // gitleaks:allow -- reviewed public SQL SHA256, not a credential
  "007_sort_order": "d5496ae9c21b799426461569e736882bfea9dd48e61912796dc6c009178905a9",
  "008_roadmap_experiment_link": "209936570e4d408ed285a3b1f2347bf3dfabf72195e1fec0d6a6e652a67e8fe5",
  "009_feedback_voting": "fd10a5cbfd4c86c687e37508b95d1093fb11db1370f18d0e6cf45da14b616f59",
  "010_feedback_indexes": "54a28ba14cf19bf66c07a8d6aae4ada97b468eaa71465aa44910e01167b52339",
  "011_docs": "4574ea446771a375db10305e6c813b6af874ca264b4b3f47df63b5c4e5d91a2c",
  "012_doc_metadata": "de01e0397efe5a1bad24c105058389c8c3e8415903f7134b5918bb5b296c3290",
  "013_portal_auth": "b04fff5bcc4f39d79e8c2f501e468fe1c3aa527b8b658657220914b6f225ac1b", // gitleaks:allow -- reviewed public SQL SHA256, not a credential
  "014_feedback_type": "ce125e2bb5c7039952713adeb04fd78bca3b788d34d414e5e8057481e064eba2",
  "015_roadmap_dates": "016543bef52421de347ab0b01049e8b1a3332d3dcfe001b711cd66e88347a913",
  "016_audit_fields_source_tracking": "6a47017a3531dd08ca00fb8e7ca4172dd4b985e562ea983a1926055d594f4e1c",
  "017_evidence_graph": "06c6c2bcf29297dc5407a2f3f6999ab1827fb85a0eff48c269c8d377057f57c9",
  "018_workspace_branding": "435486ee3a98831ce1065a74d9c73b7c844cd16b122e9d39d01fd15d306f3990",
  "019_scoring_models": "36c62b583c4e947a2a606f2a1797c0af98c562ed7f6e5e55c4fa532d5d72ec8b",
  "020_portal_sso": "7bc2a19d895f69b7d8237720f9a9939e432648c31c5e4c18e2c80a6f3176d385",
  "021_feedback_attachments": "7c4f8b729aebd11a57710334e0b7d9faaf05f89d125b61d6f9f69f68b1c861f1",
  "022_solution_comments": "85076367c39f31675e37f6159e2b355c844bacf38e48513cc956d67423cee3a3",
  "023_solution_comment_plan_status": "d7284ae661ba86117829e3cc54a45b9b8ddb3ecc08189d7dba7151baf69df9f6",
  "024_canvas_node_positions": "6a23af825d1cf9335de92ed11e4974b9def0fc9841ba9651eb23964467cc6c50",
  "024_launch_tiers_checklists": "17b66d6a85ba2fd828461bdf2d348df11b85899d09c29748ea2a0f7b5b18252f",
  "025_doc_gtm_positioning_brief": "a6320a7b862d6d7a5c361b1588a10b4ebc22f471bb276753b5697c5bb787c6ba",
  "026_roadmap_private_items": "c0b414730567ea551068eff112779a1c5b4faa7e8bf6e66402dcf70704a37a6e",
  "027_tasks": "b11fd0d0c1e93dfb3e1cf5e95097c4bcb44c85665feeed92aa18be8c84cf6e37",
  "028_agent_runtime_config": "e2209021519ab7bcac27662943c9a364531d5e806467b7ffb949cd1e8932ea42",
  "029_agent_conversations": "c5eaceed42f79ea99ee79d430b592c9ed95c63357884465b70f645d23a510a10",
  "030_agent_audit_log": "c99fa5544169962706449e9c2e13f91554566b7285da37041339e99ce9b99cc2",
  "031_doc_versions": "8352baff9ed76058e4903fba88f350c162ccac87f5248f80a9ed4b52912ab8bd",
  "032_doc_comments": "18f593b641254eba2b1fd397f68b2780ca501b830beb5b4173607710fc41a80e",
  "033_feedback_grid_indexes": "49615a033efce35f82b03482f3a26914bed6ff8da53f043e916b5592dd51eeef",
  "034_artifacts": "64ea0b977fcfb306c12f18c635c69e15e36e0dca4a4229146c4c0f98ee18bf27",
  "034_research_capture": "1a392f231c01552af7b09273e3947dc720c5113ca462fe05ad8daa869a55023c",
  "035_research_agent_scope": "5d109bf9a2fb90688e13399d7c3a82d00057de9a45dd9d7f9ec7f06a3959e3cd",
  "036_research_capture_hardening": "5a26bdc0a79056cf2c3e50bffa188f5073b2101be91dda043cb28fa6a7f4e588",
  "037_research_guided_ux": "8eb7aad049ad1230b34a75767829c4f865886a4b04a318534eeb6c399d85a82a",
  "038_research_blob_cleanup": "8e78c5c68af7f77982cdf297c78582bf9eaabe4d8df3ea36aa52c2f1cd36286a",
  "039_native_decision_gates": "6b3963c37005235997e41a31f2dfa0535ab400dd706191499902c03edba4b610",
  "040_release_authorization": "9db00fee6b83b010452d681b13cbb5dee560d1a586f59a1194ccf0d57680d014",
  "041_portfolio_capacity_ledger": "76c0ea3abd587f02fefc9c3c85dc119375308c1d9db54618e6dcbbf544c58265",
  "042_native_decision_gates_repair": "bb5bbb11b5328bb6f7597d4c8a8962ced34758931183b7aa3376df13bbdddaf5",
  "043_decision_evidence_refs": "3f44d0a1fed267e29ea5d181f9e157e7c1bae3dbdf86b9de4cd2863d8656c934",
  "044_now_policy_application_evidence": "a9b456ac3910857af87560fce575deb7ba838b6a6d230f26fc345986447eb2b2",
  "045_now_gate_shadow_evaluations": "12b8c5ca4f1c3351c15511e70621e8fb177097e7a95679bcd557f9d438ad137c",
  "046_shared_comments": "68bcda249d3e43dc7034c47c6f63e2af7644105d80829986840993104b14ed3c",
  "047_preview_automation": "2ce87c1346089fc97054a43768de37dadf7c64397e1092c982031e1e8f7456ca",
  "047_capability_packs": "637622567408a78427d51b4fbd1bb5abe2462199b3a90270710bf93fc430eb8e",
  "048_legacy_decision_review_repair": "4fb4dc31290dd1536082fdf3213daff5ed6383030c52a418e128535c57778e3b",
  "047_research_voice_control_plane": "b918c8990abc623a879dec25fc4d9c31902d31b12bc4eab424d8805d6fe9614a",
  "049_agent_identity": "5daabb7a1061edf7d8c11eb552afe98d7b721d1db7d8092fe076330d7f9a7ace",
  "049_research_participant_voice": "6ada9f5d922284dd2c598729cb7219b0fc18aaa51f6632c64e9bb94550e4713f",
  "050_pm_interviews": "7e838e1363500475277250eb72a16b5e116b51c3dd2a170742a1f502dda809e0",
  "051_pm_agent_handoff": "1782216a98e13cfe480c71860936a208686efd72783be4070ac1f84278875c5e",
  "050_experiment_not_pursued": "0d407b27e5cf477d257f80b8c278ba266a17dd4b66e6e4802ff1dd312182d021",
  "051_decision_task_bridge": "8e7f9e0a2ef68cec4baa85545b90a01970844afda52842a31e0fe3f8f0946538",
  "052_research_evidence_promotion": "509fa22736df7537b8361b7c9822544aff05096b281220fc8a71a1aa9ff28855",
  "053_shared_field_option_sets": "91a336907579271ad3c5528fb64646f61abcb15f0f3646dacdb16a6f1632208a",
  "054_research_study_artifact": "bdf36e038fe4c9df102d466f7c4c937cb3192428f01452d9a7dab64051cb8569",
  "054_workspace_wip_limits": "ae716b17ae7217d7ed4dd1f97cc5cdccf8cdef0b4f498a9e1d7d6079d2e04651",
  "054_webauthn_authenticators": "c564faa1d652b5bbaecd542d15a0111f745393c9c5e2283eb0e7dcee0182dacb", // gitleaks:allow -- reviewed public SQL SHA256, not a credential
  "055_workspace_launch_workflow_flag": "057618e3cbf1a452088adc7fae16144b022578fd58694f90dfeb91926288ed63",
  "055_oauth_authorization_server": "04e23b11d8094473649718a2038200c1743dfeeb7c077befb8ce78112d77af6f",
  "056_agent_scoped_oauth_binding": "e640c9d9f1280fbd7bd87ee230db79682c33d1b9e7b8d754d36b5b033ac7583a", // gitleaks:allow -- reviewed public SQL SHA256, not a credential
  "057_oauth_forced_reconsent": "200fadbc2dd8890aab94c7fed5fa1b6b36268cdbf7a03ea03934008fb11d9afe", // gitleaks:allow -- reviewed public SQL SHA256, not a credential
  "058_oauth_authorization_events": "3c9d762d52ed8e0cbe907cb84ab1ae7d38afdbcfbcdfac3b5f092eac018f3ff8",
  "059_geode_document_storage": "6d4b1d6d2ef578cfc313b0eb5e788bfdaf65401e1e740dd7c38e986871d9b628",
  "060_workspace_updates": "3479312bcae3d33fce394a47d05b16223f68fd4c62ac471dc9a4aeea1a90e41f",
  "061_product_analytics": "5ec89b960a7c08a86e8f37f25c41be2c9f418ff83c2cedb6855bede43911edea",
  "062_mcp_connectors": "7f66846956a857f8e4df816b3a99c35714176193d2619e82b51fc587c195d43d",
  "063_metrics_dashboard": "06d66304c5b88e7ef7f57a2e0d8d401e0bb5b2267281604ef4d841df21869947",
  "064_solution_scoring": "21f12a454e74c576b421be93f5fd65228126682d46ffb21eb7baf5f4d9a5456b"
};

export function assertReviewedManagedManifest(migrations: readonly { name: string; filePath: string }[]): void {
  const names = migrations.map(migration => migration.name);
  const reviewed = Object.keys(REVIEWED_SQL_SHA256);
  if (names.length !== reviewed.length || names.some((name, index) => name !== reviewed[index])) {
    throw new Error("Reviewed managed manifest membership changed");
  }
  for (const migration of migrations) {
    const filePath = path.join(process.cwd(), "prisma/migrations", migration.name, "migration.sql");
    if (path.resolve(migration.filePath) !== filePath) throw new Error("Reviewed managed manifest path changed");
    const digest = createHash("sha256").update(readFileSync(filePath)).digest("hex");
    if (digest !== REVIEWED_SQL_SHA256[migration.name]) throw new Error(`Reviewed managed manifest digest changed: ${migration.name}`);
  }
}
