# Skill pool index

The skill pool's first wave, vendored verbatim from
[`K-Dense-AI/scientific-agent-skills`](https://github.com/K-Dense-AI/scientific-agent-skills)
under the same rules as the Tier-1 library ([ADR 0001](docs/adr/0001-vendor-k-dense-skills-verbatim.md)):
upstream release `v2.72.0`, commit `526ebce143bc326f44471554e33d66a19c840360`,
vendored 2026-11-15. Each tree carries the six-line provenance header; the
trees live under `pool/<domain pack>/<skill>/` ([ADR 0008](docs/adr/0008-the-skill-pool-is-a-vendored-project-scoped-library.md))
and stay outside the npm tarball. Integrity pins ride `test/expected-pool.json`;
re-syncs follow [docs/agents/resync.md](docs/agents/resync.md).

The class column is verified against each `SKILL.md`'s stated requirements,
not the upstream README:

- **local** — no credential, no spend; the deterministic default a keyless session may load.
- **key** — a credential is needed, no metered spend; keyed owner sessions only (the ADR 0008 gate records the decision in `skills.json`).
- **cloud** — credential plus metered spend; owner approval, one call at a time.

Cluster structure prediction keeps routing through theta-compute
([ADR 0004](docs/adr/0004-compute-is-a-native-mcp-server.md)); Tamarind and
Adaptyv stay the documented no-cluster fallbacks, key-bearing.

| name | pack | class | when needed |
|------|------|-------|-------------|
| adaptyv | protein-engineering | cloud | designs and submits Adaptyv Foundry protein-characterization experiments (binding, thermostability, epitope binning); paid lab spend |
| esm | protein-engineering | key | ESM3 generation, ESMC embeddings, ESMFold2 folding; local inference runs keyless, the hosted Biohub path needs ESM_API_KEY |
| glycoengineering | protein-engineering | local | glycosylation-site scanning, sequon analysis, NetNGlyc/NetOGlyc/GlycoSHIELD workflow prep |
| relion | protein-engineering | local | RELION single-particle cryo-EM refinement validation and half-map postprocessing |
| tamarind | protein-engineering | cloud | cloud structure prediction and design (AlphaFold, Boltz, RFdiffusion, DiffDock, docking, MD) on the Tamarind platform; the documented no-cluster fallback |
| alphagenome | bioinformatics | key | AlphaGenome variant-effect lookup and on-demand scoring for SNV interpretation; free non-commercial key required |
| anndata | bioinformatics | local | annotated single-cell matrices; .h5ad and Zarr I/O in the scverse ecosystem |
| arboreto | bioinformatics | local | gene-regulatory-network inference (GRNBoost2, GENIE3) from expression data |
| biopython | bioinformatics | local | sequence and structure workhorse plus NCBI/PubMed access; Entrez calls need a contact email by NCBI policy, not a credential |
| bioservices | bioinformatics | local | cross-database queries through UniProt, KEGG, ChEMBL, Reactome, QuickGO, UniChem |
| bulk-rnaseq | bioinformatics | local | FASTQ-to-counts bulk RNA-seq preparation, validated count assembly, PyDESeq2 handoff |
| cellxgene-census | bioinformatics | local | population-scale public single-cell and spatial queries against the CZ CELLxGENE Census |
| deeptools | bioinformatics | local | ChIP-seq/ATAC/RNA-seq signal QC, BAM-to-bigWig, heatmaps and profiles |
| etetoolkit | bioinformatics | local | phylogenetic tree manipulation, comparison, annotation, and rendering with ETE 4 |
| flowio | bioinformatics | local | low-level FCS cytometry-file reading, inspection, and repair |
| flowkit | bioinformatics | local | flow cytometry compensation, transforms, hierarchical gating, FlowJo reproduction |
| geniml | bioinformatics | local | genomic-interval model planning (Region2Vec, scEmbed) with universe contracts |
| genomic-coordinates | bioinformatics | local | interval and variant coordinate conversion, normalization, assembly-mismatch audits |
| genomic-intelligence | bioinformatics | key | hosted DNA-language-model predictions (promoters, splicing, enhancers, expression); REST needs GI_API_KEY, the hosted MCP demo runs keyless |
| gget | bioinformatics | local | quick gene, structure, and enrichment lookups across 20+ resources |
| gtars | bioinformatics | local | genomic interval set algebra, overlaps, tokenization, refget/BEDbase planning |
| mageck | bioinformatics | local | pooled CRISPR screen analysis with MAGeCK count/test and gene hit rankings |
| onekgpd | bioinformatics | local | individual-level queries over the 1000 Genomes Project cohort |
| pathway-enrichment | bioinformatics | local | ORA, GSEA, and ssGSEA enrichment with gene-ID mapping and background choice |
| phylogenetics | bioinformatics | local | tree building from alignments with MAFFT, IQ-TREE, and FastTree |
| polars-bio | bioinformatics | local | genomic interval operations and I/O on Polars DataFrames |
| primer-design | bioinformatics | local | PCR and RT-qPCR primer design with off-target audits (Primer3) |
| pydeseq2 | bioinformatics | local | bulk RNA-seq differential-expression fitting with PyDESeq2 |
| pysam | bioinformatics | local | SAM/BAM/CRAM/VCF/FASTQ reading, filtering, and writing with pysam |
| qiime2-amplicon | bioinformatics | local | paired-end 16S amplicon processing to QIIME 2 ASVs with artifact provenance |
| scanpy | bioinformatics | local | single-cell RNA-seq QC, normalization, clustering, and marker ranking |
| scikit-bio | bioinformatics | local | microbiome diversity metrics, ordination, and PERMANOVA |
| scvelo | bioinformatics | local | RNA velocity fits and velocity graphs from spliced/unspliced counts |
| scvi-tools | bioinformatics | local | probabilistic single-cell models: batch integration, annotation, multimodal |
| tiledbvcf | bioinformatics | local | variant-call storage and indexed cohort queries with TileDB-VCF |
| waypoint-bio | bioinformatics | key | Outpost Bio microbiome foundation models (Waypoint, Atlas, Compass); gated Hugging Face repos need HF_TOKEN |
| zarr-python | bioinformatics | local | chunked N-D scientific array storage and queries with Zarr 3 |
| datamol | cheminformatics | local | RDKit wrapper for standard drug-discovery molecule work |
| deepchem | cheminformatics | local | molecular property prediction and MoleculeNet workflows with DeepChem |
| diffdock | cheminformatics | local | protein-small-molecule docking pose prediction with DiffDock |
| medchem | cheminformatics | local | medicinal-chemistry filters, structural alerts, and library triage |
| molecular-dynamics | cheminformatics | local | OpenMM/MDAnalysis simulation setup and trajectory analysis |
| molfeat | cheminformatics | local | molecular featurization for QSAR and virtual screening |
| nmrglue | cheminformatics | local | calibrated 1D NMR processing to phased, integrated spectra |
| pytdc | cheminformatics | local | Therapeutics Data Commons datasets, splits, and benchmarks |
| rdkit | cheminformatics | local | fine-grained cheminformatics toolkit control |
| rowan | cheminformatics | cloud | hosted molecular modeling (pKa, docking, cofolding, conformers); each calculation consumes credits |
| torchdrug | cheminformatics | local | TorchDrug molecular-graph workflows: property prediction, generation, retrosynthesis |
