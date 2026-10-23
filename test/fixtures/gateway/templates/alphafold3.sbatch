#!/bin/bash
#SBATCH --job-name={{JOB_NAME}}
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=2
#SBATCH --partition=gpu
#SBATCH --gres=gpu:1

cd {{RUN_DIR}}
/opt/example/singularity/bin/singularity exec \
--env XLA_FLAGS="--xla_gpu_enable_triton_gemm=false --xla_disable_hlo_passes=custom-kernel-fusion-rewriter" \
--nv \
--bind {{RUN_DIR}}/af_input:/root/af_input \
--bind /opt/example/nvidia/current:/usr/local/nvidia \
--bind {{RUN_DIR}}/af_output:/root/af_output \
--bind /opt/example/af3/models:/root/models \
--bind /opt/example/af3/databases:/root/public_databases \
/opt/example/sif/alphafold3.sif python run_alphafold.py \
--json_path=/root/af_input/fold_input.json \
--model_dir=/root/models \
--db_dir=/root/public_databases \
--output_dir=/root/af_output \
--flash_attention_implementation=xla
