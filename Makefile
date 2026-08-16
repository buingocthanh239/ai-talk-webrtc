REGION   := ap-southeast-1
REGISTRY := 762871078113.dkr.ecr.$(REGION).amazonaws.com
IMAGE    := $(REGISTRY)/ai-talk-rtc-test
TAG      ?= latest

# May build la Mac arm64, ECS/EC2 gan nhu chac chan la amd64. Khong ghim
# platform thi image push len chay duoc o local ma chet o server voi loi
# "exec format error". Chay tren Graviton thi doi thanh linux/arm64.
PLATFORM ?= linux/amd64

.PHONY: login build push dev deploy

login:
	aws ecr get-login-password --region $(REGION) | docker login --username AWS --password-stdin $(REGISTRY)

build:
	docker build --platform $(PLATFORM) -t $(IMAGE):$(TAG) .

push: login build
	docker push $(IMAGE):$(TAG)

# make deploy  -> :latest
deploy: push

# make dev     -> :dev
dev:
	$(MAKE) push TAG=dev
